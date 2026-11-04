//! 旧版应用数据导入
//!
//! 应用身份（`identifier`）由 `com.smompublish.tool` 调整为 `com.smompublish.tool.step` 后，
//! 数据目录随之变化（Windows 为 `%APPDATA%\<identifier>`，macOS/Linux 为对应系统数据目录）。
//! 老用户升级后看到的是一个空程序，本模块提供一次性迁移：
//!
//! 1. 【检测】读取旧身份数据目录，列出可导入文件（数据库 / 配置 / 日志）；
//! 2. 【导入】把旧目录内容复制到当前数据目录下的 `pending_import/` 暂存区；
//! 3. 【生效】下次启动时（`setup` 最早期，数据库与配置文件尚未被打开）把暂存区覆盖到当前
//!    数据目录，原数据先备份到 `pre_import_backup_<时间戳>/`。
//!
//! 之所以走「重启生效」而不是立即覆盖：`smom.db` 在程序运行期间被 SQLite 持有文件锁，
//! 直接覆盖会失败或产生不一致数据；暂存 + 启动时替换是唯一稳妥的时序。
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 历史应用身份（调整 identifier 之前的取值）
const LEGACY_IDENTIFIERS: [&str; 1] = ["com.smompublish.tool"];
/// 待生效的导入暂存目录名（位于当前数据目录下）
const PENDING_DIR: &str = "pending_import";
/// 导入前的数据备份目录名前缀
const BACKUP_PREFIX: &str = "pre_import_backup_";

/// 单个可导入文件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyFileInfo {
    /// 相对路径（顶层文件即文件名）
    pub name: String,
    /// 字节数
    pub size: u64,
    /// 最后修改时间（本地时区，YYYY-MM-DD HH:MM:SS）
    pub modified: String,
}

/// 旧版数据检测结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDataInfo {
    /// 是否检测到旧版数据
    pub found: bool,
    /// 旧版数据目录
    pub legacy_dir: String,
    /// 当前数据目录
    pub current_dir: String,
    /// 可导入文件列表
    pub files: Vec<LegacyFileInfo>,
    /// 可导入总字节数
    pub total_size: u64,
    /// 是否已有待生效的导入（true 表示已导入、等重启）
    pub pending: bool,
}

/// 导入结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResult {
    /// 已暂存文件数
    pub files: usize,
    /// 已暂存字节数
    pub bytes: u64,
    /// 待生效暂存目录
    pub pending_dir: String,
}

/// 数据备份（导入 / 恢复前自动生成于当前数据目录下）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDataBackupInfo {
    /// 备份目录名（含时间戳，作为操作凭据）
    pub name: String,
    /// 备份目录绝对路径
    pub path: String,
    /// 文件数
    pub files: usize,
    /// 总字节数
    pub total_size: u64,
    /// 备份时间（由目录名时间戳解析，失败退回目录修改时间）
    pub created_at: String,
}

/// 旧版数据目录候选：系统数据目录 / 配置目录 + 旧 identifier
///
/// Windows、macOS 上 `app_data_dir` 与 `app_config_dir` 相同，仅 Linux 分离
/// （数据在 `~/.local/share`、配置在 `~/.config`），两处都要探测。
fn legacy_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for base in [app.path().data_dir(), app.path().config_dir()]
        .into_iter()
        .flatten()
    {
        for identifier in LEGACY_IDENTIFIERS {
            let candidate = base.join(identifier);
            if !dirs.contains(&candidate) {
                dirs.push(candidate);
            }
        }
    }
    dirs
}

/// 旧版数据目录：优先返回真实存在的那个
fn legacy_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let candidates = legacy_dirs(app);
    if candidates.is_empty() {
        return Err("获取系统数据目录失败".to_string());
    }
    if let Some(found) = candidates.iter().find(|p| p.is_dir()) {
        return Ok(found.clone());
    }
    Ok(candidates[0].clone())
}

/// 当前数据目录候选（Windows/macOS 去重后只剩一个）
fn current_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in [app.path().app_data_dir(), app.path().app_config_dir()]
        .into_iter()
        .flatten()
    {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// 当前数据目录（主目录：暂存区与备份都在这里）
fn current_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))
}

/// 递归收集目录下的文件（相对路径 + 大小 + 修改时间）
fn collect_files(root: &Path, base: &Path, out: &mut Vec<LegacyFileInfo>) -> Result<u64, String> {
    let mut total = 0u64;
    let entries =
        std::fs::read_dir(root).map_err(|e| format!("读取目录失败[{}]: {}", root.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            total += collect_files(&path, base, out)?;
            continue;
        }
        let rel = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let modified = meta
            .modified()
            .ok()
            .map(|t| {
                chrono::DateTime::<chrono::Local>::from(t)
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string()
            })
            .unwrap_or_default();
        total += meta.len();
        out.push(LegacyFileInfo {
            name: rel,
            size: meta.len(),
            modified,
        });
    }
    Ok(total)
}

/// 递归复制目录，返回（文件数, 字节数）
fn copy_tree(src: &Path, dst: &Path) -> Result<(usize, u64), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败[{}]: {}", dst.display(), e))?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    let entries =
        std::fs::read_dir(src).map_err(|e| format!("读取目录失败[{}]: {}", src.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let target = dst.join(entry.file_name());
        let meta = entry.metadata().map_err(|e| format!("读取文件信息失败: {}", e))?;
        if meta.is_dir() {
            let (f, b) = copy_tree(&path, &target)?;
            files += f;
            bytes += b;
        } else {
            std::fs::copy(&path, &target).map_err(|e| {
                format!(
                    "复制文件失败[{} -> {}]: {}（若旧版本程序仍在运行，请先退出后重试）",
                    path.display(),
                    target.display(),
                    e
                )
            })?;
            files += 1;
            bytes += meta.len();
        }
    }
    Ok((files, bytes))
}

/// 检测旧版应用数据（设置页打开时调用）
#[tauri::command]
pub fn detect_legacy_app_data(app: tauri::AppHandle) -> Result<LegacyDataInfo, String> {
    let legacy = legacy_dir(&app)?;
    let current = current_dir(&app)?;
    let mut files = Vec::new();
    let mut total_size = 0u64;
    let found = legacy.is_dir();
    if found {
        total_size = collect_files(&legacy, &legacy, &mut files).unwrap_or(0);
    }
    files.sort_by_key(|a| std::cmp::Reverse(a.size));
    Ok(LegacyDataInfo {
        found: found && !files.is_empty(),
        legacy_dir: legacy.to_string_lossy().to_string(),
        current_dir: current.to_string_lossy().to_string(),
        files,
        total_size,
        pending: current.join(PENDING_DIR).is_dir(),
    })
}

/// 把来源目录复制进待生效暂存区（导入旧版数据、恢复备份共用）
fn stage_into_pending(app: &tauri::AppHandle, src: &Path) -> Result<LegacyImportResult, String> {
    let current = current_dir(app)?;
    std::fs::create_dir_all(&current).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    let pending = current.join(PENDING_DIR);
    // 重复导入 / 恢复：先清掉上一次的暂存
    if pending.is_dir() {
        std::fs::remove_dir_all(&pending).map_err(|e| format!("清理上次暂存失败: {}", e))?;
    }
    let (files, bytes) = copy_tree(src, &pending)?;
    if files == 0 {
        return Err("来源数据为空，无可导入文件".to_string());
    }
    Ok(LegacyImportResult {
        files,
        bytes,
        pending_dir: pending.to_string_lossy().to_string(),
    })
}

/// 导入旧版应用数据：复制到当前数据目录的暂存区，重启后生效
#[tauri::command]
pub fn import_legacy_app_data(app: tauri::AppHandle) -> Result<LegacyImportResult, String> {
    let legacy = legacy_dir(&app)?;
    if !legacy.is_dir() {
        return Err(format!("未检测到旧版本数据目录：{}", legacy.display()));
    }
    stage_into_pending(&app, &legacy)
}

/// 备份目录名 → 展示时间（目录名形如 pre_import_backup_20261104201530）
fn backup_created_at(name: &str, dir: &Path) -> String {
    let stamp = name.strip_prefix(BACKUP_PREFIX).unwrap_or(name);
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d%H%M%S") {
        return dt.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    std::fs::metadata(dir)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            chrono::DateTime::<chrono::Local>::from(t)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_default()
}

/// 校验备份目录名并返回目录路径（只允许当前数据目录下、带备份前缀的目录，防目录穿越）
fn backup_dir(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if !name.starts_with(BACKUP_PREFIX) || name.contains(['/', '\\']) || name.contains("..") {
        return Err(format!("非法的备份目录名：{}", name));
    }
    let dir = current_dir(app)?.join(name);
    if !dir.is_dir() {
        return Err(format!("备份不存在：{}", name));
    }
    Ok(dir)
}

/// 列出当前数据目录下的所有数据备份（导入 / 恢复前自动生成）
#[tauri::command]
pub fn list_appdata_backups(app: tauri::AppHandle) -> Result<Vec<AppDataBackupInfo>, String> {
    let current = current_dir(&app)?;
    let mut list: Vec<AppDataBackupInfo> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&current) else {
        return Ok(list);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(BACKUP_PREFIX) {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        let total_size = collect_files(&path, &path, &mut files).unwrap_or(0);
        list.push(AppDataBackupInfo {
            created_at: backup_created_at(&name, &path),
            path: path.to_string_lossy().to_string(),
            files: files.len(),
            total_size,
            name,
        });
    }
    // 新备份在前（目录名内嵌时间戳，字符串倒序即时间倒序）
    list.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(list)
}

/// 恢复某个备份：把备份内容复制进暂存区，重启后生效
///
/// 走与导入相同的暂存机制：生效前当前数据会再自动备份一份，误操作可再恢复回来。
#[tauri::command]
pub fn restore_appdata_backup(
    app: tauri::AppHandle,
    name: String,
) -> Result<LegacyImportResult, String> {
    let backup = backup_dir(&app, &name)?;
    stage_into_pending(&app, &backup)
}

/// 删除某个备份
#[tauri::command]
pub fn delete_appdata_backup(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let backup = backup_dir(&app, &name)?;
    std::fs::remove_dir_all(&backup).map_err(|e| format!("删除备份失败: {}", e))
}

/// 备份「即将被导入数据覆盖」的现存文件
///
/// 只备份与暂存区同路径且当前已存在的文件，返回备份文件数。
fn backup_overwritten(pending: &Path, current: &Path, backup: &Path) -> usize {
    let mut count = 0usize;
    let Ok(entries) = std::fs::read_dir(pending) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let target = current.join(entry.file_name());
        let bkp = backup.join(entry.file_name());
        if meta.is_dir() {
            count += backup_overwritten(&entry.path(), &target, &bkp);
        } else if target.is_file() {
            if let Some(parent) = bkp.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::copy(&target, &bkp).is_ok() {
                count += 1;
            }
        }
    }
    count
}

/// 启动时应用待生效的导入（须在数据库/配置文件被打开之前调用）
///
/// 失败（如文件被占用）时保留暂存目录，本次继续使用原数据，下次启动再试。
pub fn apply_pending(app: &tauri::AppHandle) {
    let dirs = current_dirs(app);
    let Some(primary) = dirs.first().cloned() else {
        println!("[appdata_import] 跳过导入：无法获取应用数据目录");
        return;
    };
    let pending = primary.join(PENDING_DIR);
    if !pending.is_dir() {
        return;
    }

    // 1. 备份将被覆盖的当前数据
    let backup = primary.join(format!(
        "{}{}",
        BACKUP_PREFIX,
        chrono::Local::now().format("%Y%m%d%H%M%S")
    ));
    let backed_up = backup_overwritten(&pending, &primary, &backup);
    if backed_up == 0 {
        let _ = std::fs::remove_dir_all(&backup);
    }

    // 2. 覆盖到当前数据目录（Linux 上前端 SQLite 落在 config_dir，需一并覆盖）
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut failed: Option<String> = None;
    for dir in &dirs {
        match copy_tree(&pending, dir) {
            Ok((f, b)) => {
                files += f;
                bytes += b;
            }
            Err(e) => {
                failed = Some(e);
                break;
            }
        }
    }

    match failed {
        None => {
            let _ = std::fs::remove_dir_all(&pending);
            println!(
                "[appdata_import] 已导入旧版数据 {} 个文件（{} 字节），原数据备份 {} 个文件于 {}",
                files,
                bytes,
                backed_up,
                backup.display()
            );
        }
        Some(e) => {
            println!(
                "[appdata_import] 导入失败，保留暂存待下次启动重试：{}（暂存目录 {}）",
                e,
                pending.display()
            );
        }
    }
}
