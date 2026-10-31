use crate::cmd_module::cancel::{
    check_cancelled, check_file_cancelled, is_cancelled, is_file_cancelled, sleep_with_cancel,
    sleep_with_file_cancel, CANCELLED_MSG, FILE_OP_CANCELLED_MSG,
};
use crate::cmd_module::ssh_pool;
use crate::utils::compression::{
    copy_with_progress, create_zip, scan_zip_sources, unzip_files, with_mtime,
};
use crate::utils::progress::ProgressState;
use crate::utils::msbuild::{build_project, build_solution};
use chrono::{DateTime, Local, NaiveDateTime};
use encoding_rs::GBK;
use encoding_rs::UTF_8;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::fs::File;
use std::io::ErrorKind;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::str;
use std::time::Instant;
use std::time::Duration;
use walkdir::WalkDir;
use zip::{write::FileOptions, ZipWriter};

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(2);

/// 重试事件推送给前端的事件名（前端 listen 后写入界面日志）
const RETRY_EVENT: &str = "backend-retry";

/// 上传/下载分块大小（256KB）：按块读写以便在长任务中途推进进度
const IO_CHUNK: usize = 256 * 1024;

/// 向前端推送一条重试事件（同时在终端打印，便于开发排查）
///
/// 事件负载：`{ "source": 来源命令, "attempt": 当前第几次, "total": 总次数,
///             "willRetry": 是否还会重试, "message": 错误信息 }`
/// 前端未监听时 emit 失败可忽略，不影响主流程。
fn emit_retry(
    app: Option<&tauri::AppHandle>,
    source: &str,
    attempt: u32,
    total: u32,
    will_retry: bool,
    message: &str,
) {
    if will_retry {
        eprintln!("尝试 {} 失败: {}，正在重试...", attempt, message);
    } else {
        eprintln!("尝试 {} 失败: {}，已达最大次数.", attempt, message);
    }
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            RETRY_EVENT,
            serde_json::json!({
                "source": source,
                "attempt": attempt,
                "total": total,
                "willRetry": will_retry,
                "message": message,
            }),
        );
    }
}

/// 智能解码字节流：优先尝试 UTF-8，失败回退到 GBK
///
/// 适配混合服务器场景：
/// - Linux 服务器：默认输出为 UTF-8
/// - Windows 服务器/本地 cmd：默认输出为 GBK（简体中文 ANSI 代码页）
///
/// 由于 UTF-8 格式严格（非法字节序列一定校验失败），可作为安全的首选尝试；
/// 失败后再回退到 GBK，避免 Linux 输出被当作 GBK 解码产生乱码。
fn smart_decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (cow, _, _) = GBK.decode(bytes);
            cow.to_string()
        }
    }
}

/// 连接远程服务器
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn server_connection(
    username: &str,
    password: &str,
    server: &str,
) -> Result<bool, String> {
    // 测试连接需要严格校验"当前传入的密码"，先丢弃池中可能存在的旧会话，
    // 否则若用户改了密码但池中仍缓存着旧会话，会误报连通成功。
    ssh_pool::invalidate(username, server);

    match ssh_pool::get_session(username, password, server) {
        Ok(_) => Ok(true),
        Err(e) => Err(e),
    }
}

/// 在远程服务器上执行命令
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
/// * `command` - 执行的命令
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn execute_remote_command(
    app: tauri::AppHandle,
    username: &str,
    password: &str,
    server: &str,
    command: &str,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
) -> Result<String, String> {
    let max_attempts = retry_count.unwrap_or(MAX_RETRIES).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut attempts = 0;

    while attempts < max_attempts {
        check_cancelled()?;
        match remote_command(username, password, server, command).await {
            Ok(output) => return Ok(output),
            Err(e) => {
                attempts += 1;
                emit_retry(
                    Some(&app),
                    "远程命令",
                    attempts,
                    max_attempts,
                    attempts < max_attempts,
                    &e,
                );
                if attempts < max_attempts && !sleep_with_cancel(delay) {
                    return Err(CANCELLED_MSG.to_string());
                }
            }
        }
    }
    Err(format!(
        "尝试 {} 次后，仍无法执行命令：{}",
        attempts, command
    ))
}

/// 服务器上执行命令
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
/// * `command` - 执行的命令
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
async fn remote_command(
    username: &str,
    password: &str,
    server: &str,
    command: &str,
) -> Result<String, String> {
    // 从连接池取（或新建）已认证的 SSH 会话
    let shared = ssh_pool::get_session(username, password, server)?;

    // 在锁内完成 channel 全生命周期，避免 libssh2 同会话并发使用
    let channel_outcome: Result<(i32, String, String), String> = (|| {
        let mut entry = shared.lock().map_err(|_| "SSH 会话锁中毒".to_string())?;

        let (exit_status, stdout, stderr) = {
            let mut channel = entry
                .session
                .channel_session()
                .map_err(|_| "无法打开远程命令通道".to_string())?;
            println!("执行远程命令: {}", command);
            channel
                .exec(command)
                .map_err(|_| "无法执行命令".to_string())?;

            let mut stdout_bytes = Vec::new();
            let mut stderr_bytes = Vec::new();
            channel
                .read_to_end(&mut stdout_bytes)
                .map_err(|_| "无法读取命令输出".to_string())?;
            channel
                .stderr()
                .read_to_end(&mut stderr_bytes)
                .map_err(|_| "无法读取命令错误输出".to_string())?;
            channel
                .wait_close()
                .map_err(|_| "无法关闭命令通道".to_string())?;
            let status = channel
                .exit_status()
                .map_err(|_| "无法获取命令退出状态".to_string())?;

            (
                status,
                smart_decode_bytes(&stdout_bytes),
                smart_decode_bytes(&stderr_bytes),
            )
        };

        entry.last_used = Instant::now();
        Ok((exit_status, stdout, stderr))
    })();

    match channel_outcome {
        Ok((exit_status, stdout, stderr)) => {
            if exit_status == 0 {
                Ok(stdout)
            } else {
                // 命令业务级失败：会话本身仍可继续复用，无需丢弃
                Err(format!(
                    "命令执行异常。退出状态：{}。输出：{}；错误输出：{}",
                    exit_status, stdout, stderr
                ))
            }
        }
        Err(e) => {
            // 通道级错误（连接断开等），使会话失效以便下次重建
            ssh_pool::invalidate(username, server);
            Err(e)
        }
    }
}

/// 使某个 SSH 连接池中的会话失效（切换项目后调用）
#[tauri::command]
pub async fn invalidate_ssh_session(username: &str, server: &str) -> Result<bool, String> {
    ssh_pool::invalidate(username, server);
    Ok(true)
}

/// 判断文件或目录是否存在
///
/// # Arguments
/// * `path` - 文件目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn exists(path: &str) -> Result<bool, String> {
    let path = Path::new(path);
    if path.exists() {
        Ok(true)
    } else {
        Err(format!("路径[{}]不存在！", path.display()))
    }
}

/// 判断文件或目录是否存在
///
/// # Arguments
/// * `path` - 文件目录路径
/// * `is_rebuild` - 是否重新编译
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn build_project_release(
    project_file_path: &str,
    msbuild_path: &str,
    is_rebuild: bool,
    build_mode: &str,
) -> Result<bool, String> {
    match build_project(project_file_path, msbuild_path, is_rebuild, build_mode) {
        Ok(_) => Ok(true),
        Err(e) => Err(e),
    }
}

/// 编译解决方案（项目发布 STEP【编译解决方案】使用）
///
/// 一次 MSBuild 调用编译整个 .sln，而非逐个 csproj 编译；编译期间可被发布停止标记中断。
///
/// # Arguments
/// * `solution_path` - 解决方案文件路径（.sln）
/// * `msbuild_path` - MSBuild 编译路径
/// * `is_rebuild` - 是否重新编译（Rebuild / Build）
/// * `build_mode` - 生成模式（Release / Debug）
/// * `platform` - 平台（Any CPU / x64 / x86），留空则不传
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败，返回错误行（被手动停止时为「已手动停止」）
#[tauri::command]
pub async fn build_solution_release(
    solution_path: &str,
    msbuild_path: &str,
    is_rebuild: bool,
    build_mode: &str,
    platform: &str,
) -> Result<bool, String> {
    match build_solution(solution_path, msbuild_path, is_rebuild, build_mode, platform) {
        Ok(_) => Ok(true),
        Err(e) => Err(e),
    }
}

/// 判断文件夹是否为空目录
///
/// # Arguments
/// * `path` - 文件目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn is_dir_empty(path: &str) -> Result<bool, String> {
    match fs::read_dir(path) {
        Ok(entries) => Ok(entries.peekable().peek().is_none()),
        Err(e) => Err(e.to_string()),
    }
}

/// 创建文件目录
///
/// # Arguments
/// * `path` - 文件目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn create_dir(path: &str) -> Result<bool, String> {
    let path = Path::new(path);
    match fs::create_dir_all(path) {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

/// 目录压缩[ZIP]文件
///
/// # Arguments
/// * `src_dir` - 文件夹路径
/// * `dst_file` - 输出的zip文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn zip_dir(app: tauri::AppHandle, src_dir: &str, dst_file: &str) -> Result<bool, String> {
    let mut progress = ProgressState::new(Some(&app));
    let path = Path::new(src_dir);
    let file = File::create(dst_file).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);

    let options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    // 预扫描：文件数与总字节作为进度分母（扫描失败退化为 0，即不定长展示）
    let (file_total, total_bytes) = scan_zip_sources(&[src_dir]);
    let mut file_index: u32 = 0;
    let mut processed: u64 = 0;

    for entry in WalkDir::new(path) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = path
            .strip_prefix(Path::new(src_dir))
            .map_err(|e| e.to_string())?;

        if path.is_file() {
            file_index += 1;
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            // zip.start_file_from_path(name, options)
            // 写入本地修改时间：避免「打包上传 → 服务端解压」后文件时间变成 1980 年
            zip.start_file(path_to_string(name), with_mtime(options, path))
                .map_err(|e| e.to_string())?;
            let mut f = File::open(path).map_err(|e| e.to_string())?;
            copy_with_progress(
                &mut f,
                &mut zip,
                &file_name,
                file_index,
                file_total,
                &mut processed,
                total_bytes,
                Some(&mut progress),
            )
            .map_err(|e| e.to_string())?;
        } else if path.is_dir() && !name.as_os_str().is_empty() {
            // zip.add_directory_from_path(name, options)
            zip.add_directory(path_to_string(name), with_mtime(options, path))
                .map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    progress.emit_force("zip", "", processed, total_bytes, file_index, file_total);
    Ok(true)
}

/// 批量压缩的单个源：本地目录 + zip 内的顶层目录名
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipDirSource {
    /// 本地源目录，如 `<程序集输出>/WebApiHost`
    pub src_dir: String,
    /// zip 内的顶层目录名，如 `WebApiHost`（WpfClient 取 packOutput 的内容落成 `WpfClient/`）
    pub entry: String,
}

/// 多目录压缩[ZIP]文件：把一个或多个本地目录压进同一个 zip，各目录在 zip 内落成 `<entry>/` 顶层目录
///
/// 与 `zip_dir` 的差异：`zip_dir` 把单个目录的内容平铺在 zip 根，无法表达多个模块各自一个顶层目录；
/// `create_zip` 虽支持多路径但用 Stored 不压缩，且顶层目录名固定取路径末级名字（WpfClient 需要 `packOutput` → `WpfClient` 的映射）。
///
/// # Arguments
/// * `sources` - 源目录列表（src_dir 本地目录，entry zip 内顶层目录名）
/// * `dst_file` - 输出的zip文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn zip_dirs(
    app: tauri::AppHandle,
    sources: Vec<ZipDirSource>,
    dst_file: &str,
) -> Result<bool, String> {
    if sources.is_empty() {
        return Err("没有需要压缩的目录.".to_string());
    }
    let mut progress = ProgressState::new(Some(&app));
    let file = File::create(dst_file).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);

    let options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    // 进度分母：全部源目录的文件数与总字节（扫描失败退化为 0，即不定长展示）
    let src_dirs: Vec<&str> = sources.iter().map(|s| s.src_dir.as_str()).collect();
    let (file_total, total_bytes) = scan_zip_sources(&src_dirs);
    let mut file_index: u32 = 0;
    let mut processed: u64 = 0;

    for source in &sources {
        let entry = source.entry.trim_matches('/').trim_matches('\\');
        if entry.is_empty() {
            return Err("压缩包内的顶层目录名为空.".to_string());
        }
        let src_path = Path::new(&source.src_dir);
        if !src_path.is_dir() {
            return Err(format!("源目录不存在：{}", source.src_dir));
        }
        // 顶层目录条目
        zip.add_directory(entry, with_mtime(options, src_path))
            .map_err(|e| e.to_string())?;

        for entry_result in WalkDir::new(src_path) {
            let entry_item = entry_result.map_err(|e| e.to_string())?;
            let path = entry_item.path();
            if path == src_path {
                // 根目录已作为顶层目录写入
                continue;
            }
            let name = path
                .strip_prefix(src_path)
                .map_err(|e| e.to_string())?;
            let zip_name = format!("{}/{}", entry, path_to_string(name));

            if path.is_file() {
                file_index += 1;
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                // 写入本地修改时间：避免「打包上传 → 服务端解压」后文件时间变成 1980 年
                zip.start_file(zip_name, with_mtime(options, path))
                    .map_err(|e| e.to_string())?;
                let mut f = File::open(path).map_err(|e| e.to_string())?;
                copy_with_progress(
                    &mut f,
                    &mut zip,
                    &file_name,
                    file_index,
                    file_total,
                    &mut processed,
                    total_bytes,
                    Some(&mut progress),
                )
                .map_err(|e| e.to_string())?;
            } else if path.is_dir() {
                zip.add_directory(zip_name, with_mtime(options, path))
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    progress.emit_force("zip", "", processed, total_bytes, file_index, file_total);
    Ok(true)
}

fn path_to_string(path: &std::path::Path) -> String {
    let mut path_str = String::new();
    for component in path.components() {
        if let std::path::Component::Normal(os_str) = component {
            if !path_str.is_empty() {
                path_str.push('/');
            }
            path_str.push_str(&os_str.to_string_lossy());
        }
    }
    path_str
}

/// 压缩[ZIP]文件
///
/// # Arguments
/// * `file_paths` - 文件|文件夹路径
/// * `dst_file` - 输出的zip文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn compress_zip(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
    dst_file: &str,
) -> Result<bool, String> {
    let mut progress = ProgressState::new(Some(&app));
    // 直接将Vec<String>转换为Vec<&str>，减少中间步骤
    let file_paths: Vec<&str> = file_paths.iter().map(String::as_str).collect();
    // 调用create_zip函数并处理结果
    create_zip(&file_paths, dst_file, Some(&mut progress))
        .map_err(|e| e.to_string())
        .map(|_| true)
}

/// 解压压缩文件
///
/// # Arguments
/// * `file_paths` - 文件路径
/// * `destination` - 输出解压路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn un_zip(file_paths: Vec<String>, destination: &str) -> Result<bool, String> {
    let file_paths: Vec<&str> = file_paths.iter().map(String::as_str).collect();
    unzip_files(&file_paths, destination)
        .map_err(|e| e.to_string())
        .map(|_| true)
}

/// 读取文件目录中的文件
///
/// # Arguments
/// * `path` - 文件目录
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_files(path: &str) -> Result<Vec<String>, String> {
    match fs::read_dir(path) {
        Ok(entries) => {
            let mut file_names = Vec::new();
            for entry in entries {
                match entry {
                    Ok(entry) => {
                        if let Ok(file_name) = entry.file_name().into_string() {
                            file_names.push(file_name);
                        }
                    }
                    Err(e) => return Err(format!("获取条目出错: {}", e)),
                }
            }
            Ok(file_names)
        }
        Err(e) => Err(format!("读取目录出错: {}", e)),
    }
}

/// 查找 Directory Opus 的请求器工具 dopusrt.exe
///
/// 按以下顺序检测，取第一个存在 dopusrt.exe 的目录：
/// 1. 官方注册表键 `SOFTWARE\GPSoftware\Directory Opus` → `InstallDirectory`（HKLM/HKCU，覆盖 64/32 位注册表视图）
/// 2. 扫描 Uninstall 键中 DisplayName 为 `Directory Opus` 的条目，取 `InstallLocation` / `Inno Setup: App Path`（兼容非标准安装）
/// 3. 文件系统默认目录 `%ProgramFiles%\GPSoftware\Directory Opus`（含 x86 目录）
///
/// # Returns
/// * `Some(path)` dopusrt.exe 完整路径
/// * `None` 未安装 Directory Opus，调用方应回退到系统资源管理器
fn find_directory_opus_rt() -> Option<PathBuf> {
    use winreg::enums::*;
    use winreg::RegKey;

    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Directory Opus 官方注册表键：HKLM/HKCU × 64 位/32 位注册表视图
    let sam_flags = [KEY_READ | KEY_WOW64_64KEY, KEY_READ | KEY_WOW64_32KEY];
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for sam in sam_flags {
            let predef = RegKey::predef(root);
            if let Ok(key) =
                predef.open_subkey_with_flags(r"SOFTWARE\GPSoftware\Directory Opus", sam)
            {
                if let Ok(dir) = key.get_value::<String, _>("InstallDirectory") {
                    candidates.push(PathBuf::from(dir));
                }
            }
        }
    }

    // 2. Uninstall 注册表键：兼容自定义 Inno Setup 打包等非标准安装
    let uninstall_paths = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let predef = RegKey::predef(root);
        for uninstall_path in uninstall_paths {
            let uninstall = match predef.open_subkey(uninstall_path) {
                Ok(k) => k,
                Err(_) => continue,
            };
            for entry in uninstall.enum_keys().flatten() {
                let app = match uninstall.open_subkey(&entry) {
                    Ok(k) => k,
                    Err(_) => continue,
                };
                let display_name: String = app.get_value("DisplayName").unwrap_or_default();
                if display_name != "Directory Opus" {
                    continue;
                }
                if let Ok(dir) = app.get_value::<String, _>("InstallLocation") {
                    candidates.push(PathBuf::from(dir.trim_end_matches(['\\', '/'])));
                } else if let Ok(dir) = app.get_value::<String, _>("Inno Setup: App Path") {
                    candidates.push(PathBuf::from(dir));
                }
            }
        }
    }

    // 3. 文件系统默认安装目录
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(base) = env::var_os(var) {
            candidates.push(PathBuf::from(base).join(r"GPSoftware\Directory Opus"));
        }
    }

    // 校验候选目录：必须存在 dopusrt.exe 才视为有效安装
    for dir in candidates {
        let rt = dir.join("dopusrt.exe");
        if rt.is_file() {
            return Some(rt);
        }
    }
    None
}

/// 打开文件目录
///
/// Windows 下优先使用 Directory Opus（已安装时通过 dopusrt.exe 打开），
/// 未安装或启动失败时回退到系统资源管理器 explorer。
///
/// # Arguments
/// * `path` - 文件目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn open_dir(path: &str) -> Result<bool, String> {
    // 处理路径
    let path = Path::new(path);
    let path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return Err("路径无效！".to_string());
        }
    };
    let path_str = path.to_str().ok_or_else(|| "路径转换失败".to_string())?;

    // 去除 canonicalize 在 Windows 上添加的 \\?\ 扩展长度前缀：
    // explorer 对该前缀透明兼容，但 Directory Opus 会原样显示，需剥离；
    // \\?\UNC\server\share 形式需还原为 \\server\share
    let path_string = if let Some(rest) = path_str.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path_str
            .strip_prefix(r"\\?\")
            .unwrap_or(path_str)
            .to_string()
    };
    let path_str = path_string.as_str();

    // 获取当前操作系统信息
    let os_type = env::consts::OS;

    // 根据操作系统类型执行不同的命令
    let result = match os_type {
        "windows" => {
            // 优先 Directory Opus：dopusrt.exe /acmd 会在 DOpus 未运行时先拉起主程序，
            // 再执行 Go 命令；NEWTAB=tofront 在最近活动窗口新开标签（不覆盖用户当前
            // 浏览的目录），并把窗口恢复/置前，保证打开结果对用户可见
            match find_directory_opus_rt() {
                Some(rt) => match Command::new(&rt)
                    .args(["/acmd", "Go", path_str, "NEWTAB=tofront"])
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .spawn()
                {
                    Ok(child) => Ok(child),
                    Err(_) => Command::new("explorer").arg(path_str).spawn(),
                },
                None => Command::new("explorer").arg(path_str).spawn(),
            }
        }
        "macos" => Command::new("open").arg(path_str).spawn(),
        "linux" => Command::new("xdg-open").arg(path_str).spawn(),
        _ => {
            return Err("不支持的操作系统".to_string());
        }
    };

    match result {
        Ok(_) => Ok(true),
        Err(e) => Err(format!("无法打开目录: {}", e)),
    }
}

/// 复制路径文件
///
/// # Arguments
/// * `source` - 文件|文件夹来源路径
/// * `destination` - 文件|文件夹目标路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn copy_path(
    source: &str,
    destination: &str,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
) -> Result<bool, String> {
    let source = Path::new(source);
    let destination = Path::new(destination);

    if !source.exists() {
        // 不存在源文件直接忽略吧
        return Ok(true);
    }

    if source.is_dir() {
        // 检查并创建目标文件夹
        if !destination.exists() {
            if let Err(e) = fs::create_dir_all(destination) {
                return Err(e.to_string());
            }
        }

        for entry in match fs::read_dir(source) {
            Ok(entries) => entries,
            Err(e) => return Err(e.to_string()),
        } {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => return Err(e.to_string()),
            };
            let entry_path = entry.path();
            let entry_name = entry.file_name();

            // 递归复制子文件或子目录（透传重试参数）
            let source_path = entry_path.to_str().ok_or("源路径无效")?;
            let destination_path_tmp = destination.join(entry_name);
            let destination_path = destination_path_tmp.to_str().ok_or("目标路径无效")?;
            Box::pin(copy_path(
                source_path,
                destination_path,
                retry_count,
                retry_interval_secs,
            ))
            .await?;
        }
        return Ok(true);
    }

    // 复制文件（带重试）
    // retry_count = None 或 0 → 单次尝试（旧行为）；否则按 retry_count 次尝试，间隔 retry_interval_secs 秒
    let max_attempts = retry_count.unwrap_or(0).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut last_err = String::new();
    for attempt in 1..=max_attempts {
        check_cancelled()?;
        match fs::copy(source, destination) {
            Ok(_) => return Ok(true),
            Err(e) => {
                last_err = e.to_string();
                eprintln!(
                    "复制失败 [{}/{}]: {} -> {}",
                    attempt,
                    max_attempts,
                    source.display(),
                    last_err
                );
                if attempt < max_attempts && !sleep_with_cancel(delay) {
                    return Err(CANCELLED_MSG.to_string());
                }
            }
        }
    }
    Err(format!(
        "复制失败（尝试 {} 次）：{}",
        max_attempts, last_err
    ))
}

/// 复制路径(时间段内)文件
///
/// # Arguments
/// * `source` - 文件|文件夹来源路径
/// * `destination` - 文件|文件夹目标路径
/// * `start_time` - 开始时间 格式: "%Y-%m-%d %H:%M:%S"
/// * `end_time` - 结束时间 格式: "%Y-%m-%d %H:%M:%S"
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn copy_path_by_time(
    source: &str,
    destination: &str,
    start_time: &str,
    end_time: &str,
) -> Result<bool, String> {
    // 解析时间
    let start_date = match NaiveDateTime::parse_from_str(start_time, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(e) => return Err(format!("解析开始时间失败: {}", e)),
    };

    let end_date = match NaiveDateTime::parse_from_str(end_time, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(e) => return Err(format!("解析结束时间失败: {}", e)),
    };

    let source = Path::new(source);
    if !source.exists() {
        // 不存在源文件直接忽略吧
        return Ok(true);
    }

    let destination = Path::new(destination);
    if source.is_dir() {
        // 检查并创建目标文件夹
        if !destination.exists() {
            if let Err(e) = fs::create_dir_all(destination) {
                return Err(format!("创建目标文件夹失败: {}", e));
            }
        }
        for entry in match fs::read_dir(source) {
            Ok(entries) => entries,
            Err(e) => return Err(format!("读取源文件夹失败: {}", e)),
        } {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => return Err(format!("读取文件夹条目失败: {}", e)),
            };
            let entry_path = entry.path();
            let entry_name = entry.file_name();

            // 递归复制子文件或子目录
            let source_path = entry_path.to_str().ok_or("无效的源路径字符串")?;
            let destination_path_tmp = destination.join(entry_name); // 创建一个临时变量
            let destination_path = destination_path_tmp
                .to_str()
                .ok_or("无效的目标路径字符串")?; // 借用这个临时变量
                                                 /*
                                                 let copy_result = copy_path_by_time(source_path, destination_path, start_time, end_time);
                                                 if let Err(e) = copy_result {
                                                     return Err(format!("递归复制失败: {}", e));
                                                 }
                                                 */
            Box::pin(copy_path_by_time(
                source_path,
                destination_path,
                start_time,
                end_time,
            ))
            .await?;
        }
        return Ok(true);
    }

    // 复制文件
    let metadata = match fs::metadata(source) {
        Ok(meta) => meta,
        Err(e) => return Err(format!("获取文件元数据失败: {}", e)),
    };
    let modified_time: NaiveDateTime = match metadata.modified() {
        Ok(time) => {
            let datetime: DateTime<Local> = time.into();
            datetime.naive_local()
        }
        Err(e) => return Err(format!("获取文件修改时间失败: {}", e)),
    };
    if modified_time >= start_date && modified_time <= end_date {
        if let Err(e) = fs::copy(source, destination) {
            return Err(format!("复制文件失败: {}", e));
        }
    }
    Ok(true)
}

/// 复制文件夹中的所有*.dll文件
///
/// # Arguments
/// * `source` - 来源路径
/// * `destination` - 目标路径
/// * `del_destination` - 删除目标路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn copy_dll_files(
    source: &str,
    destination: &str,
    del_destination: bool,
) -> Result<bool, String> {
    let src_dir = Path::new(source);
    let dst_dir = Path::new(destination);

    // 删除目标文件夹
    if del_destination {
        if let Err(e) = delete_dir(destination).await {
            return Err(e.to_string());
        }
    }

    // 检查并创建目标文件夹
    if !dst_dir.exists() {
        if let Err(e) = fs::create_dir_all(dst_dir) {
            return Err(format!("无法创建目标目录: {}", e));
        }
    }

    for entry in match fs::read_dir(src_dir) {
        Ok(entries) => entries,
        Err(e) => return Err(format!("无法读取源目录: {}", e)),
    } {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => return Err(format!("无法读取目录条目: {}", e)),
        };
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "dll") {
            let destination_file = dst_dir.join(path.file_name().ok_or("无效的文件名")?);
            if let Err(e) = fs::copy(&path, &destination_file) {
                return Err(format!("无法复制文件: {}", e));
            }
        }
    }

    Ok(true)
}

/// 复制文件夹中的所有(时间段内)*.dll文件
///
/// # Arguments
/// * `source` - 来源路径
/// * `destination` - 目标路径
/// * `del_destination` - 删除目标路径
/// * `start_time` - 开始时间 格式: "%Y-%m-%d %H:%M:%S"
/// * `end_time` - 结束时间 格式: "%Y-%m-%d %H:%M:%S"
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn copy_dll_files_by_time(
    source: &str,
    destination: &str,
    del_destination: bool,
    start_time: &str,
    end_time: &str,
) -> Result<bool, String> {
    // 解析时间
    let start_date = match NaiveDateTime::parse_from_str(start_time, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(e) => return Err(format!("无法解析开始时间: {}", e)),
    };

    let end_date = match NaiveDateTime::parse_from_str(end_time, "%Y-%m-%d %H:%M:%S") {
        Ok(dt) => dt,
        Err(e) => return Err(format!("无法解析结束时间: {}", e)),
    };

    let src_dir = Path::new(source);
    let dst_dir = Path::new(destination);

    // 删除目标文件夹
    if del_destination {
        if let Err(e) = delete_dir(destination).await {
            return Err(e.to_string());
        }
    }

    // 检查并创建目标文件夹
    if !dst_dir.exists() {
        if let Err(e) = fs::create_dir_all(dst_dir) {
            return Err(format!("无法创建目标目录: {}", e));
        }
    }

    for entry in match fs::read_dir(src_dir) {
        Ok(entries) => entries,
        Err(e) => return Err(format!("无法读取源目录: {}", e)),
    } {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => return Err(format!("无法读取目录条目: {}", e)),
        };
        let path = entry.path();
        if path.is_file() && path.extension().unwrap_or_default() == "dll" {
            let metadata = match fs::metadata(&path) {
                Ok(meta) => meta,
                Err(e) => return Err(format!("无法获取文件的元数据: {}", e)),
            };
            let modified_time: NaiveDateTime = match metadata.modified() {
                Ok(time) => {
                    let datetime: DateTime<Local> = time.into();
                    datetime.naive_local()
                }
                Err(e) => return Err(format!("无法获取文件的修改时间: {}", e)),
            };

            if modified_time >= start_date && modified_time <= end_date {
                let destination_file = match path.file_name() {
                    Some(filename) => dst_dir.join(filename),
                    None => return Err("无法获取文件名".to_string()),
                };
                if let Err(e) = fs::copy(&path, &destination_file) {
                    return Err(format!("无法复制文件: {}", e));
                }
            }
        }
    }

    Ok(true)
}

/// 移动文件
///
/// # Arguments
/// * `source` - 来源路径
/// * `destination` - 目标路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn move_file(source: &str, destination: &str) -> Result<bool, String> {
    let src_path = Path::new(source);
    let dest_path = Path::new(destination);

    // 检查是否在同一个盘符
    if let (Some(src_drive), Some(dest_drive)) =
        (src_path.components().next(), dest_path.components().next())
    {
        if src_drive == dest_drive {
            // 尝试重命名
            return match fs::rename(source, destination) {
                Ok(_) => Ok(true),
                Err(e) => Err(format!("移动文件失败: {}", e)),
            };
        }
    }

    // 不在同一个盘符，使用复制+删除
    if let Err(e) = fs::copy(source, destination) {
        return Err(format!("复制文件失败: {}", e));
    }
    if let Err(e) = fs::remove_file(source) {
        return Err(format!("删除原文件失败: {}", e));
    }
    Ok(true)
}

/// 删除给定路径列表中的文件或文件夹
///
/// # Arguments
/// * `paths` - 要删除的文件或目录路径列表
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn delete_paths(paths: Vec<String>) -> Result<bool, String> {
    for src in paths {
        let path = Path::new(&src);
        if path.is_file() {
            if let Err(e) = delete_file(&src).await {
                return Err(e.to_string());
            }
        } else if path.is_dir() {
            if let Err(e) = delete_dir(&src).await {
                return Err(e.to_string());
            }
        } else {
            return Err(format!("路径 {} 不是文件或目录", src));
        }
    }
    Ok(true)
}

/// 删除文件
///
/// # Arguments
/// * `path` - 要删除的文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn delete_file(path: &str) -> Result<bool, String> {
    let path = Path::new(path);
    match fs::remove_file(path) {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

/// 删除目录,包括所有子文件和子目录
///
/// # Arguments
/// * `path` - 要删除的目录路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn delete_dir(path: &str) -> Result<bool, String> {
    let path = Path::new(path);
    match fs::remove_dir_all(path) {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

/// 下载远程服务器文件到本地
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 远程服务器地址
/// * `remote_paths` - 远程文件路径
/// * `local_paths` - 本地文件路径
/// * `cancel_scope` - 取消范围：`"file"` 认文件操作终止标记，其余认发布停止标记
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn download_server_files(
    app: tauri::AppHandle,
    local_paths: Vec<String>,
    remote_paths: Vec<String>,
    username: &str,
    password: &str,
    server: &str,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
    cancel_scope: Option<String>,
) -> Result<bool, String> {
    let mut progress = ProgressState::new(Some(&app));
    // 文件管理弹窗发起的下载用独立标记，避免与发布「停止」互相打断
    let file_scope = cancel_scope.as_deref() == Some("file");
    // retry_count = None → 内建默认 3 次/2s（直连调用点行为不变）；前端重试包装传 1 单发，重试由前端控制
    let max_attempts = retry_count.unwrap_or(MAX_RETRIES).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut attempts = 0;
    let mut err_msg = String::new();
    while attempts < max_attempts {
        if file_scope {
            check_file_cancelled()?;
        } else {
            check_cancelled()?;
        }
        match exec_download_server_files(
            local_paths.clone(),
            remote_paths.clone(),
            username,
            password,
            server,
            &mut progress,
            file_scope,
        )
        .await
        {
            Ok(output) => return Ok(output),
            Err(e) => {
                // 主动终止不再重试，原样返回（前端据文案标记「已终止 / 已停止」）
                if e == CANCELLED_MSG || e == FILE_OP_CANCELLED_MSG {
                    return Err(e);
                }
                attempts += 1;
                emit_retry(
                    Some(&app),
                    "下载文件",
                    attempts,
                    max_attempts,
                    attempts < max_attempts,
                    &e,
                );
                if attempts < max_attempts {
                    let slept = if file_scope {
                        sleep_with_file_cancel(delay)
                    } else {
                        sleep_with_cancel(delay)
                    };
                    if !slept {
                        return Err(if file_scope {
                            FILE_OP_CANCELLED_MSG.to_string()
                        } else {
                            CANCELLED_MSG.to_string()
                        });
                    }
                }
                err_msg = e.to_string();
            }
        }
    }
    // 错误以具体原因为主体（如"下载文件[路径]失败！"），次数作后缀；
    // 不再包"仍无法下载…到本地"外壳，避免与前端"文件上传失败，N s 后重试"等包装语重复
    Err(format!("{}（已尝试 {} 次）", err_msg, attempts))
}

/// 下载远程服务器文件到本地
///
/// # Arguments
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 远程服务器地址
/// * `remote_paths` - 远程文件路径
/// * `local_paths` - 本地文件路径
/// * `file_scope` - 是否使用文件操作取消标记（文件管理弹窗下载时为 true）
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[allow(clippy::too_many_arguments)]
async fn exec_download_server_files(
    local_paths: Vec<String>,
    remote_paths: Vec<String>,
    username: &str,
    password: &str,
    server: &str,
    progress: &mut ProgressState,
    file_scope: bool,
) -> Result<bool, String> {
    if local_paths.len() != remote_paths.len() {
        return Err("本地路径和远程路径的数量必须相同.".into());
    }
    let file_total = local_paths.len() as u32;

    // 从连接池取（或新建）已认证的 SSH 会话
    let shared = ssh_pool::get_session(username, password, server)?;

    let outcome: Result<bool, String> = (|| {
        let mut entry = shared.lock().map_err(|_| "SSH 会话锁中毒".to_string())?;

        let sftp = entry
            .session
            .sftp()
            .map_err(|e| format!("无法创建 SFTP 会话: {}", e))?;
        for (index, (local_path, remote_path)) in
            local_paths.iter().zip(remote_paths.iter()).enumerate()
        {
            let file_index = (index + 1) as u32;
            let local_path = Path::new(local_path);
            let remote_path = Path::new(remote_path);
            if remote_path_is_dir(&sftp, remote_path) {
                // 递归下载目录
                for entry in WalkDir::new(remote_path) {
                    let entry = entry.map_err(|e| format!("无法读取目录条目: {}", e))?;
                    let entry_path = entry.path();
                    let relative_path = entry_path.strip_prefix(remote_path).unwrap();
                    let local_file_path = local_path.join(relative_path);
                    if remote_path_is_dir(&sftp, entry_path) {
                        // 创建本地目录
                        std::fs::create_dir_all(&local_file_path)
                            .map_err(|e| format!("无法创建本地目录: {:?}", e))?;
                    } else {
                        // 下载文件
                        download_server_file(
                            entry_path,
                            &local_file_path,
                            &sftp,
                            progress,
                            file_index,
                            file_total,
                            file_scope,
                        )
                        .map_err(|e| format!("下载文件[{}]失败！{}", entry_path.display(), e))?;
                    }
                }
            } else {
                // 下载单个文件
                download_server_file(
                    remote_path,
                    local_path,
                    &sftp,
                    progress,
                    file_index,
                    file_total,
                    file_scope,
                )
                .map_err(|e| format!("下载文件[{}]失败！{}", remote_path.display(), e))?;
            }
        }

        entry.last_used = Instant::now();
        Ok(true)
    })();

    match outcome {
        Ok(_) => Ok(true),
        Err(e) => {
            ssh_pool::invalidate(username, server);
            Err(e)
        }
    }
}

/// 验证远程服务器路径是否是目录
///
/// # Arguments
/// * `sftp` - SFTP会话
/// * `path` - 远程路径
///
/// # Returns
/// * `true` 成功 - 路径是目录
/// * `false` 失败 - 路径不是目录
// 这是一个辅助函数，用于确定远程路径是否是目录
fn remote_path_is_dir(sftp: &ssh2::Sftp, path: &Path) -> bool {
    if let Ok(metadata) = sftp.stat(path) {
        metadata.is_dir()
    } else {
        false
    }
}

/// 下载远程服务器文件（分块读写，中途推送进度）
///
/// # Arguments
/// * `remote_path` - 远程文件路径
/// * `local_path` - 本地文件路径
/// * `sftp` - SFTP会话
/// * `progress` - 进度推送器
/// * `file_index` - 第几个文件（1-based）
/// * `file_total` - 共几个文件
/// * `file_scope` - 是否使用文件操作取消标记
///
/// # Returns
/// * `Ok(())` 成功
/// * `Err(String)` 失败（含手动停止）
#[allow(clippy::too_many_arguments)]
fn download_server_file(
    remote_path: &Path,
    local_path: &Path,
    sftp: &ssh2::Sftp,
    progress: &mut ProgressState,
    file_index: u32,
    file_total: u32,
    file_scope: bool,
) -> Result<(), String> {
    // 远程文件大小：stat 失败时为 0，退化为不定长进度（只显示已下载字节）
    let total = sftp.stat(remote_path).ok().and_then(|s| s.size).unwrap_or(0);
    let file_name = remote_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let mut remote_file = sftp
        .open(remote_path)
        .map_err(|e| format!("无法打开远程文件: {}", e))?;
    let mut local_file = File::create(local_path)
        .map_err(|e| format!("无法创建本地文件[{}]: {}", local_path.display(), e))?;

    let mut buffer = vec![0u8; IO_CHUNK];
    let mut transferred: u64 = 0;
    loop {
        // 文件管理弹窗下载认文件操作终止标记，发布流程下载认发布停止标记
        let cancelled = if file_scope {
            is_file_cancelled()
        } else {
            is_cancelled()
        };
        if cancelled {
            return Err(if file_scope {
                FILE_OP_CANCELLED_MSG.to_string()
            } else {
                CANCELLED_MSG.to_string()
            });
        }
        let read_len = remote_file
            .read(&mut buffer)
            .map_err(|e| format!("读取远程文件失败: {}", e))?;
        if read_len == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..read_len])
            .map_err(|e| format!("写入本地文件[{}]失败: {}", local_path.display(), e))?;
        transferred += read_len as u64;
        progress.emit(
            "download",
            &file_name,
            transferred,
            total,
            file_index,
            file_total,
        );
    }
    progress.emit_force(
        "download",
        &file_name,
        transferred,
        total,
        file_index,
        file_total,
    );
    Ok(())
}

/// 远程目录一级条目（文件管理弹窗「查看文件」用）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    /// 条目名称
    pub name: String,
    /// 远端完整路径（原样返回远端分隔符）
    pub path: String,
    /// 是否目录
    pub is_dir: bool,
    /// 字节大小（目录为 0）
    pub size: u64,
    /// 修改时间（Unix 秒，0 = 未知）
    pub modified: u64,
}

/// 列出远程目录一级文件/文件夹（走 SFTP，一次连接拿到名称/类型/大小/修改时间）
///
/// 只列一级，不递归；`.` / `..` 已过滤；结果目录在前、名称升序。
/// 读取失败（路径不存在 / 无权限）返回带路径的错误文案，供前端直接展示。
///
/// # Arguments
/// * `cancel_scope` - 取消范围：`"file"` 认文件操作终止标记，其余认发布停止标记
#[tauri::command]
pub async fn list_remote_dir(
    username: &str,
    password: &str,
    server: &str,
    remote_path: &str,
    cancel_scope: Option<String>,
) -> Result<Vec<RemoteDirEntry>, String> {
    let file_scope = cancel_scope.as_deref() == Some("file");
    if file_scope {
        check_file_cancelled()?;
    } else {
        check_cancelled()?;
    }

    // SFTP 读取是阻塞调用，放进独立线程避免卡住 Tokio 运行时；
    // 主循环 200ms 轮询终止标记，终止后立即返回（后台线程随 SSH 会话超时自然结束，结果被丢弃）
    let username = username.to_string();
    let password = password.to_string();
    let server = server.to_string();
    let remote_path = remote_path.to_string();
    let mut task =
        tokio::task::spawn_blocking(move || list_remote_dir_blocking(&username, &password, &server, &remote_path));
    loop {
        tokio::select! {
            res = &mut task => {
                return res.map_err(|e| format!("读取远程目录线程异常: {}", e))?;
            }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                let cancelled = if file_scope {
                    is_file_cancelled()
                } else {
                    is_cancelled()
                };
                if cancelled {
                    return Err(if file_scope {
                        FILE_OP_CANCELLED_MSG.to_string()
                    } else {
                        CANCELLED_MSG.to_string()
                    });
                }
            }
        }
    }
}

/// `list_remote_dir` 的阻塞实现（供 spawn_blocking 调用）
fn list_remote_dir_blocking(
    username: &str,
    password: &str,
    server: &str,
    remote_path: &str,
) -> Result<Vec<RemoteDirEntry>, String> {
    let shared = ssh_pool::get_session(username, password, server)?;
    let mut entries: Vec<RemoteDirEntry> = {
        let mut entry = shared.lock().map_err(|_| "SSH 会话锁中毒".to_string())?;
        let sftp = entry
            .session
            .sftp()
            .map_err(|e| format!("无法创建 SFTP 会话: {}", e))?;
        let items = sftp.readdir(Path::new(remote_path)).map_err(|e| {
            format!(
                "无法读取远程目录[{}]：{}（请确认路径存在且账号有读取权限）",
                remote_path, e
            )
        })?;
        let mut list: Vec<RemoteDirEntry> = Vec::with_capacity(items.len());
        for (path, stat) in items {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            list.push(RemoteDirEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: stat.is_dir(),
                size: stat.size.unwrap_or(0),
                modified: stat.mtime.unwrap_or(0),
            });
        }
        entry.last_used = Instant::now();
        list
    };
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 目标已存在同名文件时的处理方式
#[derive(Clone, Copy, PartialEq, Eq)]
enum ConflictMode {
    /// 直接覆盖（默认，与历史行为一致）
    Overwrite,
    /// 已存在则跳过
    Skip,
    /// 比较修改时间：服务器上更新则跳过，本地更新则覆盖
    KeepLatest,
}

impl ConflictMode {
    /// 前端 `conflictMode` 字符串解析：`"skip"` / `"keepLatest"`，其余（含 None）覆盖
    fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("skip") => Self::Skip,
            Some("keepLatest") => Self::KeepLatest,
            _ => Self::Overwrite,
        }
    }
}

/// 上传结果汇总
///
/// 既有调用点只判 `code`、失败读 `msg`（不读 `data`），故由 `bool` 扩为对象安全；
/// 文件管理弹窗据此区分「已上传」与「已跳过（目标已存在）」。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcome {
    /// 计划条目数（本地路径数，目录按 1 条计）
    pub total: u32,
    /// 实际写入的文件数（目录会展开为多个文件）
    pub uploaded: u32,
    /// 因目标已存在而跳过的文件数（conflict_mode = "skip"）
    pub skipped: u32,
    /// 被跳过的远端路径（便于前端逐条提示）
    pub skipped_files: Vec<String>,
}

/// 上传文件到服务器
///
/// # Arguments
/// * `local_paths` - 本地文件|目录路径
/// * `remote_paths` - 远程文件|目录路径
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
/// * `conflict_mode` - 目标已存在时的处理：`"skip"` 跳过、`"keepLatest"` 保留较新的一份，其余（含 None）覆盖
/// * `cancel_scope` - 取消范围：`"file"` 认文件操作终止标记，其余认发布停止标记
///
/// # Returns
/// * `Ok(UploadOutcome)` 成功（含跳过统计）
/// * `Err(String)` 失败
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn upload_server_files(
    app: tauri::AppHandle,
    remote_paths: Vec<String>,
    local_paths: Vec<String>,
    username: &str,
    password: &str,
    server: &str,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
    conflict_mode: Option<String>,
    cancel_scope: Option<String>,
) -> Result<UploadOutcome, String> {
    let mut progress = ProgressState::new(Some(&app));
    let conflict = ConflictMode::parse(conflict_mode.as_deref());
    // 文件管理弹窗发起的上传用独立标记，避免与发布「停止」互相打断
    let file_scope = cancel_scope.as_deref() == Some("file");
    // retry_count = None → 内建默认 3 次/2s（直连调用点行为不变）；前端重试包装传 1 单发，重试由前端控制
    let max_attempts = retry_count.unwrap_or(MAX_RETRIES).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut attempts = 0;
    let mut err_msg = String::new();
    while attempts < max_attempts {
        if file_scope {
            check_file_cancelled()?;
        } else {
            check_cancelled()?;
        }
        match exec_upload_server_files(
            remote_paths.clone(),
            local_paths.clone(),
            username,
            password,
            server,
            &mut progress,
            conflict,
            file_scope,
        )
        .await
        {
            Ok(output) => return Ok(output),
            Err(e) => {
                // 主动终止不再重试，原样返回（前端据文案标记「已终止 / 已停止」）
                if e == CANCELLED_MSG || e == FILE_OP_CANCELLED_MSG {
                    return Err(e);
                }
                attempts += 1;
                emit_retry(
                    Some(&app),
                    "上传文件",
                    attempts,
                    max_attempts,
                    attempts < max_attempts,
                    &e,
                );
                if attempts < max_attempts {
                    let slept = if file_scope {
                        sleep_with_file_cancel(delay)
                    } else {
                        sleep_with_cancel(delay)
                    };
                    if !slept {
                        return Err(if file_scope {
                            FILE_OP_CANCELLED_MSG.to_string()
                        } else {
                            CANCELLED_MSG.to_string()
                        });
                    }
                }
                err_msg = e.to_string();
            }
        }
    }
    // 错误以具体原因为主体（如"上传文件[路径]失败！"），次数作后缀；
    // 不再包"仍无法将上传文件到服务器"外壳，避免与前端"文件上传失败，N s 后重试"等包装语重复
    Err(format!("{}（已尝试 {} 次）", err_msg, attempts))
}

/// 上传文件到服务器
///
/// # Arguments
/// * `local_paths` - 本地文件|目录路径
/// * `remote_paths` - 远程文件|目录路径
/// * `username` - 用户名称
/// * `password` - 用户密码
/// * `server` - 服务器地址
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[allow(clippy::too_many_arguments)]
async fn exec_upload_server_files(
    remote_paths: Vec<String>,
    local_paths: Vec<String>,
    username: &str,
    password: &str,
    server: &str,
    progress: &mut ProgressState,
    conflict: ConflictMode,
    file_scope: bool,
) -> Result<UploadOutcome, String> {
    if local_paths.len() != remote_paths.len() {
        return Err("本地路径和远程路径的数量必须相同.".into());
    }
    let file_total = local_paths.len() as u32;

    // 从连接池取（或新建）已认证的 SSH 会话
    let shared = ssh_pool::get_session(username, password, server)?;

    let outcome: Result<UploadOutcome, String> = (|| {
        let mut entry = shared.lock().map_err(|_| "SSH 会话锁中毒".to_string())?;

        let sftp = entry
            .session
            .sftp()
            .map_err(|e| format!("无法创建 SFTP 会话: {}", e))?;
        let mut result = UploadOutcome {
            total: file_total,
            uploaded: 0,
            skipped: 0,
            skipped_files: Vec::new(),
        };
        for (index, (local_path, remote_path)) in
            local_paths.iter().zip(remote_paths.iter()).enumerate()
        {
            let file_index = (index + 1) as u32;
            let local_path = Path::new(local_path);
            let remote_path = Path::new(remote_path);
            if local_path.is_dir() {
                // 递归上传目录
                for entry in WalkDir::new(local_path) {
                    let entry = entry.map_err(|e| format!("无法读取目录条目: {}", e))?;
                    let entry_path = entry.path();
                    let relative_path = entry_path.strip_prefix(local_path).unwrap();
                    let remote_file_path = remote_path.join(relative_path);
                    if entry_path.is_dir() {
                        // 创建远程目录
                        println!("创建远程目录: {}", remote_file_path.display());
                        sftp.mkdir(&remote_file_path, 0o755)
                            .map_err(|e| format!("无法创建远程目录: {:?}", e))?;
                    } else {
                        // 上传文件（按冲突模式决定是否跳过）
                        let uploaded = upload_server_file(
                            entry_path,
                            &remote_file_path,
                            &sftp,
                            progress,
                            file_index,
                            file_total,
                            conflict,
                            file_scope,
                        )
                        .map_err(|e| format!("上传文件[{}]失败！{}", entry_path.display(), e))?;
                        if uploaded {
                            result.uploaded += 1;
                        } else {
                            result.skipped += 1;
                            result
                                .skipped_files
                                .push(remote_file_path.to_string_lossy().to_string());
                        }
                    }
                }
            } else {
                // 上传单个文件
                let uploaded = upload_server_file(
                    local_path,
                    remote_path,
                    &sftp,
                    progress,
                    file_index,
                    file_total,
                    conflict,
                    file_scope,
                )
                .map_err(|e| format!("上传文件[{}]失败！{}", local_path.display(), e))?;
                if uploaded {
                    result.uploaded += 1;
                } else {
                    result.skipped += 1;
                    result
                        .skipped_files
                        .push(remote_path.to_string_lossy().to_string());
                }
            }
        }

        entry.last_used = Instant::now();
        Ok(result)
    })();

    match outcome {
        Ok(result) => Ok(result),
        Err(e) => {
            // 主动终止是用户意图，不销毁会话（下次上传还能复用）
            if e != CANCELLED_MSG && e != FILE_OP_CANCELLED_MSG {
                ssh_pool::invalidate(username, server);
            }
            Err(e)
        }
    }
}

/// 本地文件修改时间（Unix 秒）；读不到元数据/时间返回 None
fn local_mtime_secs(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_secs())
}

/// 上传服务器文件（分块读写，中途推送进度）
///
/// # Arguments
/// * `local_path` - 本地文件路径
/// * `remote_path` - 远程文件路径
/// * `sftp` - SFTP会话
/// * `progress` - 进度推送器
/// * `file_index` - 第几个文件（1-based）
/// * `file_total` - 共几个文件
/// * `conflict` - 目标已存在时的处理：覆盖 / 跳过 / 保留较新的一份
/// * `file_scope` - 是否使用文件操作取消标记（文件管理弹窗上传时为 true）
///
/// # Returns
/// * `Ok(true)` 已上传
/// * `Ok(false)` 目标已存在且按冲突模式跳过
/// * `Err(String)` 失败（含手动终止）
#[allow(clippy::too_many_arguments)]
fn upload_server_file(
    local_path: &Path,
    remote_path: &Path,
    sftp: &ssh2::Sftp,
    progress: &mut ProgressState,
    file_index: u32,
    file_total: u32,
    conflict: ConflictMode,
    file_scope: bool,
) -> Result<bool, String> {
    // 跳过 / 保留最新：先探测远端是否存在（含目录递归上传的每个子文件）
    if conflict != ConflictMode::Overwrite {
        if let Ok(remote_stat) = sftp.stat(remote_path) {
            let should_skip = match conflict {
                // 无条件跳过
                ConflictMode::Skip => true,
                // 服务器上的修改时间不旧于本地 → 保留服务器版本；本地时间读不到时按覆盖处理
                ConflictMode::KeepLatest => local_mtime_secs(local_path)
                    .map(|local| remote_stat.mtime.unwrap_or(0) >= local)
                    .unwrap_or(false),
                ConflictMode::Overwrite => false,
            };
            if should_skip {
                let file_name = local_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                let size = fs::metadata(local_path).map(|m| m.len()).unwrap_or(0);
                // 推送一次终态进度，避免前端进度条停在中途
                progress.emit_force("upload", &file_name, size, size, file_index, file_total);
                return Ok(false);
            }
        }
    }

    // 打开本地文件
    let mut local_file = File::open(local_path)
        .map_err(|e| format!("无法打开本地文件[{}]: {}", local_path.display(), e))?;
    let total = fs::metadata(local_path).map(|m| m.len()).unwrap_or(0);
    let file_name = local_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // 创建远程文件
    let mut remote_file = sftp
        .create(remote_path)
        .map_err(|e| format!("无法创建远程文件[{}]: {}", remote_path.display(), e))?;

    // 分块写入远程文件，便于长任务中途推送进度
    let mut buffer = vec![0u8; IO_CHUNK];
    let mut transferred: u64 = 0;
    loop {
        if file_scope {
            check_file_cancelled()?;
        } else if is_cancelled() {
            return Err(CANCELLED_MSG.to_string());
        }
        let read_len = local_file
            .read(&mut buffer)
            .map_err(|e| format!("读取本地文件[{}]失败: {}", local_path.display(), e))?;
        if read_len == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..read_len])
            .map_err(|e| format!("写入远程文件[{}]失败: {}", remote_path.display(), e))?;
        transferred += read_len as u64;
        progress.emit(
            "upload",
            &file_name,
            transferred,
            total,
            file_index,
            file_total,
        );
    }
    let _ = remote_file.flush();
    progress.emit_force(
        "upload",
        &file_name,
        transferred,
        total,
        file_index,
        file_total,
    );

    // 保留本地文件修改时间（供【核对程序集】逐文件比对使用），失败静默忽略不影响上传结果
    if let Some(secs) = local_mtime_secs(local_path) {
        let _ = sftp.setstat(
            remote_path,
            ssh2::FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: None,
                atime: Some(secs),
                mtime: Some(secs),
            },
        );
    }

    Ok(true)
}

/// 执行本地命令
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn execute_local_command(
    app: tauri::AppHandle,
    command: &str,
    args: Vec<String>,
    retry_count: Option<u32>,
    retry_interval_secs: Option<u64>,
) -> Result<String, String> {
    let max_attempts = retry_count.unwrap_or(MAX_RETRIES).max(1);
    let delay = retry_interval_secs
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(RETRY_DELAY);
    let mut attempts = 0;
    let mut err_msg = String::new();
    while attempts < max_attempts {
        check_cancelled()?;
        match exec_local_command(command, args.clone()).await {
            Ok(output) => return Ok(output),
            Err(e) => {
                attempts += 1;
                emit_retry(
                    Some(&app),
                    "本地命令",
                    attempts,
                    max_attempts,
                    attempts < max_attempts,
                    &e,
                );
                if attempts < max_attempts && !sleep_with_cancel(delay) {
                    return Err(CANCELLED_MSG.to_string());
                }
                err_msg = e.to_string();
            }
        }
    }
    Err(format!(
        "尝试 {} 次后，该命令仍无法执行：{}",
        attempts, err_msg
    ))
}

/// 执行本地命令
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
async fn exec_local_command(command: &str, args: Vec<String>) -> Result<String, String> {
    match Command::new(command)
        .args(args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                let (stdout, _, _) = GBK.decode(&output.stdout);
                Ok(stdout.to_string())
            } else {
                let (stderr, _, _) = GBK.decode(&output.stderr);
                Err(format!("命令失败，出现错误:\n{}", stderr))
            }
        }
        Err(e) => {
            if e.kind() == ErrorKind::NotFound {
                Err("找不到命令".to_string())
            } else {
                Err(format!("无法执行命令: {}", e))
            }
        }
    }
}

/// 运行命令
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn exec_local_command_spawn(command: &str, args: Vec<String>) -> Result<(), String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("命令失败，出现错误: {}", e))?;

    let status = child.wait().map_err(|e| format!("无法等待 child: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("命令已退出，状态为： {}", status))
    }
}

/// 执行本地命令（指定工作目录）
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
/// * `working_dir` - 工作目录
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn execute_local_command_with_working_dir(
    app: tauri::AppHandle,
    command: &str,
    args: Vec<String>,
    working_dir: &str,
) -> Result<String, String> {
    let mut attempts = 0;
    let mut err_msg = String::new();
    while attempts < MAX_RETRIES {
        check_cancelled()?;
        match exec_local_command_with_working_dir(command, args.clone(), working_dir).await {
            Ok(output) => return Ok(output),
            Err(e) => {
                attempts += 1;
                emit_retry(
                    Some(&app),
                    "本地命令（指定工作目录）",
                    attempts,
                    MAX_RETRIES,
                    attempts < MAX_RETRIES,
                    &e,
                );
                if attempts < MAX_RETRIES && !sleep_with_cancel(RETRY_DELAY) {
                    return Err(CANCELLED_MSG.to_string());
                }
                err_msg = e.to_string();
            }
        }
    }
    Err(format!(
        "尝试 {} 次后，该命令仍无法执行：{}",
        attempts, err_msg
    ))
}

/// 执行本地命令（指定工作目录）
///
/// # Arguments
/// * `command` - 执行的命令
/// * `args` - 执行的参数
/// * `working_dir` - 工作目录
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
async fn exec_local_command_with_working_dir(
    command: &str,
    args: Vec<String>,
    working_dir: &str,
) -> Result<String, String> {
    match Command::new(command)
        .args(args)
        .current_dir(working_dir)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                // 尝试使用 UTF-8 解码，如果失败则回退到 GBK 解码
                let (stdout, _encoding_used, is_errors) = UTF_8.decode(&output.stdout);
                if is_errors {
                    // 如果 UTF-8 解码出现错误，使用 GBK 解码
                    let (gbk_stdout, _, _) = GBK.decode(&output.stdout);
                    Ok(gbk_stdout.to_string())
                } else {
                    Ok(stdout.to_string())
                }
            } else {
                // 错误信息同样处理编码问题
                let (stderr, _encoding_used, is_errors) = UTF_8.decode(&output.stderr);
                if is_errors {
                    let (gbk_stderr, _, _) = GBK.decode(&output.stderr);
                    Err(format!("命令失败，出现错误:\n{}", gbk_stderr))
                } else {
                    Err(format!("命令失败，出现错误:\n{}", stderr))
                }
            }
        }
        Err(e) => {
            if e.kind() == ErrorKind::NotFound {
                Err("找不到命令".to_string())
            } else {
                Err(format!("无法执行命令: {}", e))
            }
        }
    }
}

/// 读取目录中的所有DLL文件
///
/// # Arguments
/// * `dir` - 目录路径
///
/// # Returns
/// * `Ok(Vec<String>)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_all_dlls(dir: &str) -> Result<Vec<String>, String> {
    let mut dll_files = Vec::new();

    // 迭代指定目录中的文件
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // 检查文件是否为 DLL
        if path.extension() == Some(OsStr::new("dll")) {
            if let Some(file_name) = path.to_str() {
                dll_files.push(file_name.to_string());
            }
        }
    }

    Ok(dll_files)
}

/// 读取日期范围内的DLL文件
///
/// # Arguments
/// * `dir` - 目录路径
/// * `start_date` - 起始日期
/// * `end_date` - 结束日期
///
/// # Returns
/// * `Ok(Vec<String>)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_dlls_in_date_range(
    dir: &str,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<String>, String> {
    let start_date: NaiveDateTime = NaiveDateTime::parse_from_str(start_date, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| format!("无效的起始日期: {}", e))?;
    let end_date = NaiveDateTime::parse_from_str(end_date, "%Y-%m-%d %H:%M:%S")
        .map_err(|e| format!("无效的结束日期: {}", e))?;

    let mut dll_files = Vec::new();

    // 迭代指定目录中的文件
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // 检查文件是否为 DLL
        if path.extension() == Some(OsStr::new("dll")) {
            let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;

            if let Ok(modified) = metadata.modified() {
                let modified_date: DateTime<Local> = modified.into();
                let file_date = modified_date.naive_local();

                // 检查文件的修改日期是否在指定范围内
                if file_date >= start_date && file_date <= end_date {
                    if let Some(file_name) = path.to_str() {
                        dll_files.push(file_name.to_string());
                    }
                }
            }
        }
    }

    Ok(dll_files)
}

/// 读取目录一级下文件的最新修改时间（不递归子目录，与获取程序集取文件口径一致）
///
/// # Arguments
/// * `dir` - 目录路径
///
/// # Returns
/// * `Ok(String)` 最新修改时间（本地时区 `YYYY-mm-dd HH:MM:SS`）；目录不存在或无文件时返回空字符串
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_latest_mtime(dir: &str) -> Result<String, String> {
    let mut latest: Option<DateTime<Local>> = None;
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        // 单个条目读取元数据失败时跳过，不影响整体最新时间统计
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() {
            continue;
        }
        if let Ok(modified) = metadata.modified() {
            let modified_local: DateTime<Local> = modified.into();
            if latest.is_none_or(|cur| modified_local > cur) {
                latest = Some(modified_local);
            }
        }
    }
    Ok(latest
        .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default())
}

/// 保存内容到文件
///
/// # Arguments
/// * `content` - 内容
/// * `file_path` - 文件路径
///
/// # Returns
/// * `Ok(true)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn save_content_to_file(content: &str, file_path: &str) -> Result<bool, String> {
    // 创建或打开文件
    let mut file = File::create(file_path).map_err(|e| e.to_string())?;
    // 将内容值写入文件
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// 读取内容文件
///
/// # Arguments
/// * `file_path` - 文件路径
///
/// # Returns
/// * `Ok(String)` 成功
/// * `Err(String)` 失败
#[tauri::command]
pub async fn read_content_to_file(file_path: &str) -> Result<String, String> {
    match File::open(file_path) {
        Ok(mut file) => {
            let mut contents = String::new();
            if file.read_to_string(&mut contents).is_ok() {
                Ok(contents)
            } else {
                Err("无法读取文件".to_string())
            }
        }
        Err(e) => Err(format!("打开文件时出错: {}", e)),
    }
}

/// 获取加密Key
///
/// # Returns
/// * `Ok(String)` 成功
#[tauri::command]
pub async fn get_encryption_key() -> String {
    // 先写死
    let key = "REX_SMOM_15200";
    // ...
    key.to_string()
}

/// 删除指定目录中所有以给定前缀开头的文件
///
/// # 参数
/// - `dir_path`: 要扫描并删除文件的目录路径
/// - `prefix`: 文件名前缀，用于匹配需要删除的文件
///
/// # 返回值
/// - `Ok(true)` 表示操作完成（不一定有文件被删除）
/// - `Err(String)` 表示过程中发生错误
#[tauri::command]
pub async fn delete_files_with_prefix(dir_path: &str, prefix: &str) -> Result<bool, String> {
    let path = Path::new(dir_path);

    if !path.exists() {
        return Err(format!("目录不存在: {}", dir_path));
    }

    if !path.is_dir() {
        return Err(format!("提供的路径不是一个目录: {}", dir_path));
    }

    for entry in fs::read_dir(path).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let path = entry.path();

        if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                if file_name.starts_with(prefix) {
                    if let Err(e) = fs::remove_file(&path) {
                        return Err(format!("删除文件失败 {}: {}", path.display(), e));
                    }
                }
            }
        }
    }

    Ok(true)
}

/// 根据文件名过滤器复制
///
/// # 参数
/// - `src_dir`: 源目录
/// - `dest_dir`: 目标目录
/// - `filter`: 过滤条件
///
/// # 返回值
/// - `Ok(true)` 表示操作完成
/// - `Err(String)` 表示过程中发生错误
fn copy_dlls_with_filter<P, F>(src_dir: P, dest_dir: P, filter: F) -> Result<bool, String>
where
    P: AsRef<Path>,
    F: Fn(&str) -> bool,
{
    let src = src_dir.as_ref();
    let dest = dest_dir.as_ref();

    // 确保目标目录存在
    fs::create_dir_all(dest).map_err(|e| format!("无法创建目标目录 {:?}: {}", dest, e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("无法读取源目录 {:?}: {}", src, e))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();

        // 跳过非文件项（如子目录）
        if !path.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue, // 跳过非 UTF-8 文件名（不视为错误）
        };

        // 检查是否是 .dll 文件（不区分大小写）
        if !file_name.to_lowercase().ends_with(".dll") {
            continue;
        }

        if filter(file_name) {
            let dest_path = dest.join(file_name);
            fs::copy(&path, &dest_path)
                .map_err(|e| format!("复制文件 {:?} 到 {:?} 失败: {}", path, dest_path, e))?;
        }
    }

    Ok(true) // 成功完成
}

/// 复制以SIE开头的dll文件
///
/// # 参数
/// - `src_dir`: 源目录
/// - `dest_dir`: 目标目录
///
/// # 返回值
/// - `Ok(true)` 表示操作完成
/// - `Err(String)` 表示过程中发生错误
#[tauri::command]
pub async fn copy_sie_dlls(src_dir: &str, dest_dir: &str) -> Result<bool, String> {
    copy_dlls_with_filter(src_dir, dest_dir, |file_name| file_name.starts_with("SIE"))
}

/// 复制不以SIE开头的dll文件
///
/// # 参数
/// - `src_dir`: 源目录
/// - `dest_dir`: 目标目录
///
/// # 返回值
/// - `Ok(true)` 表示操作完成
/// - `Err(String)` 表示过程中发生错误
#[tauri::command]
pub async fn copy_non_sie_dlls(src_dir: &str, dest_dir: &str) -> Result<bool, String> {
    copy_dlls_with_filter(src_dir, dest_dir, |file_name| !file_name.starts_with("SIE"))
}

use regex::Regex;
use std::collections::HashMap;
use std::time::SystemTime;

/// 将通配符模式转换为正则表达式
fn wildcard_to_regex(pattern: &str) -> Result<Regex, regex::Error> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Regex::new("^$");
    }
    let regex_str = if pattern.to_lowercase().ends_with(".dll") {
        regex::escape(pattern)
    } else {
        format!("{}\\.dll", regex::escape(pattern))
    };
    let regex_str = regex_str.replace(r"\*", ".*").replace(r"\?", ".");
    Regex::new(&format!("^{}$", regex_str))
}

/// 解析模式文本，支持换行和顿号分隔
fn parse_patterns(patterns_text: &str) -> Vec<Regex> {
    let mut patterns = Vec::new();
    for line in patterns_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 如果行中包含顿号且不含通配符，则按顿号分割
        if line.contains('、') && !line.contains('*') && !line.contains('?') {
            for item in line.split('、') {
                let item = item.trim();
                if item.is_empty() {
                    continue;
                }
                if let Ok(re) = wildcard_to_regex(item) {
                    patterns.push(re);
                }
            }
        } else if let Ok(re) = wildcard_to_regex(line) {
            patterns.push(re);
        }
    }
    patterns
}

/// 根据DLL名称模式复制文件（支持*和?通配符，同名文件保留最新的）
///
/// # 参数
/// - `source`: 源目录
/// - `destination`: 目标目录
/// - `patterns`: DLL名称模式文本，每行一个，支持顿号分隔
/// - `del_destination`: 是否先删除目标目录（避免残留旧文件）
///
/// # 返回值
/// - `Ok(true)` 表示操作完成
/// - `Err(String)` 表示过程中发生错误
#[tauri::command]
pub async fn copy_dll_files_by_name(
    source: &str,
    destination: &str,
    patterns: &str,
    del_destination: bool,
) -> Result<bool, String> {
    let src_dir = Path::new(source);
    let dst_dir = Path::new(destination);

    if !src_dir.exists() {
        return Err(format!("源目录不存在: {}", source));
    }

    // 删除目标文件夹
    if del_destination {
        if let Err(e) = delete_dir(destination).await {
            return Err(e.to_string());
        }
    }

    // 确保目标目录存在
    fs::create_dir_all(dst_dir).map_err(|e| format!("无法创建目标目录 {:?}: {}", dst_dir, e))?;

    let regex_patterns = parse_patterns(patterns);
    if regex_patterns.is_empty() {
        return Err("未提供有效的DLL匹配模式".to_string());
    }

    // 字典：filename -> (mtime, full_path)
    let mut latest_files: HashMap<String, (SystemTime, std::path::PathBuf)> = HashMap::new();

    // 遍历源目录中的所有文件
    for entry in
        fs::read_dir(src_dir).map_err(|e| format!("无法读取源目录 {:?}: {}", src_dir, e))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();

        // 跳过非文件项
        if !path.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };

        // 检查是否是 .dll 文件（不区分大小写）
        if !file_name.to_lowercase().ends_with(".dll") {
            continue;
        }

        // 尝试匹配任一模式
        let mut matched = false;
        for re in &regex_patterns {
            if re.is_match(file_name) {
                matched = true;
                break;
            }
        }

        if !matched {
            continue;
        }

        let mtime = match fs::metadata(&path).and_then(|m| m.modified()) {
            Ok(time) => time,
            Err(_) => SystemTime::UNIX_EPOCH,
        };

        // 以文件名（忽略大小写）作为唯一键，保留修改时间最新的
        let key = file_name.to_lowercase();
        if let Some((existing_mtime, _)) = latest_files.get(&key) {
            if mtime <= *existing_mtime {
                continue;
            }
        }
        latest_files.insert(key, (mtime, path));
    }

    // 复制匹配的文件
    for (_, (_, src_path)) in latest_files {
        let dest_path = dst_dir.join(
            src_path
                .file_name()
                .ok_or_else(|| "无法获取文件名".to_string())?,
        );
        fs::copy(&src_path, &dest_path)
            .map_err(|e| format!("复制文件 {:?} 到 {:?} 失败: {}", src_path, dest_path, e))?;
    }

    Ok(true)
}

/// 按DLL名称模式读取匹配的DLL文件名列表（支持*和?通配符、顿号分隔）
///
/// # 参数
/// - `dir`: 源目录
/// - `patterns`: DLL名称模式文本，每行一个，支持顿号分隔
///
/// # 返回值
/// - `Ok(Vec<String>)` 匹配的DLL文件名列表（仅文件名，不含路径）
/// - `Err(String)` 失败
#[tauri::command]
pub async fn read_dlls_by_name(dir: &str, patterns: &str) -> Result<Vec<String>, String> {
    let src_dir = Path::new(dir);
    if !src_dir.exists() {
        return Err(format!("源目录不存在: {}", dir));
    }

    let regex_patterns = parse_patterns(patterns);
    if regex_patterns.is_empty() {
        return Err("未提供有效的DLL匹配模式".to_string());
    }

    let mut dll_files = Vec::new();
    for entry in
        fs::read_dir(src_dir).map_err(|e| format!("无法读取源目录 {:?}: {}", src_dir, e))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };
        // 检查是否是 .dll 文件（不区分大小写），与 copy_dll_files_by_name 一致
        if !file_name.to_lowercase().ends_with(".dll") {
            continue;
        }
        // 尝试匹配任一模式（大小写敏感，与 copy_dll_files_by_name 一致）
        if regex_patterns.iter().any(|re| re.is_match(file_name)) {
            dll_files.push(file_name.to_string());
        }
    }
    Ok(dll_files)
}

/// 通过 vswhere 查找 TF.exe 路径
///
/// TFVC 工具位于 Visual Studio 的 Team Explorer 目录下，
/// 依赖 Microsoft.VisualStudio.TeamExplorer 组件。
#[tauri::command]
pub async fn find_tf_exe_path() -> Result<String, String> {
    let vswhere_paths = [
        "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
        "C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe",
    ];

    let vswhere = vswhere_paths
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|p| p.to_string());

    let vswhere = match vswhere {
        Some(v) => v,
        None => {
            return Err("未找到 vswhere.exe，请手动输入 TF.exe 路径".to_string());
        }
    };

    let output = Command::new(&vswhere)
        .args([
            "-latest",
            "-requires",
            "Microsoft.VisualStudio.TeamExplorer",
            "-find",
            "Common7\\IDE\\CommonExtensions\\Microsoft\\TeamFoundation\\Team Explorer\\TF.exe",
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    match output {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let path = stdout.trim();
                if !path.is_empty() && Path::new(path).exists() {
                    return Ok(path.to_string());
                }
            }
            Err("未找到 TF.exe，请手动输入路径".to_string())
        }
        Err(e) => Err(format!("查找 TF.exe 失败: {}", e)),
    }
}

/// 通过 vswhere 查找 MSBuild.exe 路径
///
/// 依赖 Microsoft.Component.MSBuild 组件，返回最新安装的 Visual Studio 下的 MSBuild。
#[tauri::command]
pub async fn find_msbuild_path() -> Result<String, String> {
    let vswhere_paths = [
        "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
        "C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe",
    ];

    let vswhere = vswhere_paths
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|p| p.to_string());

    let vswhere = match vswhere {
        Some(v) => v,
        None => {
            return Err("未找到 vswhere.exe，请手动输入 MSBuild 路径".to_string());
        }
    };

    let output = Command::new(&vswhere)
        .args([
            "-latest",
            "-requires",
            "Microsoft.Component.MSBuild",
            "-find",
            "MSBuild\\**\\Bin\\MSBuild.exe",
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    match output {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let path = stdout.trim();
                if !path.is_empty() && Path::new(path).exists() {
                    return Ok(path.to_string());
                }
            }
            Err("未找到 MSBuild.exe，请手动输入路径".to_string())
        }
        Err(e) => Err(format!("查找 MSBuild 失败: {}", e)),
    }
}


/// 查找 git.exe 路径
///
/// 优先检查常见安装目录，其次通过 where 命令从 PATH 中查找。
#[tauri::command]
pub async fn find_git_exe_path() -> Result<String, String> {
    let mut candidates: Vec<String> = vec![
        "C:\\Program Files\\Git\\cmd\\git.exe".to_string(),
        "C:\\Program Files\\Git\\bin\\git.exe".to_string(),
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe".to_string(),
    ];
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        candidates.push(format!(
            "{}\\Programs\\Git\\cmd\\git.exe",
            local_app_data
        ));
    }
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return Ok(candidate.clone());
        }
    }

    // 从 PATH 中查找
    let output = Command::new("where")
        .arg("git")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    match output {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let path = line.trim();
                    if !path.is_empty() && Path::new(path).exists() {
                        return Ok(path.to_string());
                    }
                }
            }
            Err("未找到 git.exe，请手动输入路径".to_string())
        }
        Err(e) => Err(format!("查找 git.exe 失败: {}", e)),
    }
}
