use crate::utils::progress::ProgressState;
use chrono::{Datelike, Local, TimeZone, Timelike};
use std::fs;
use std::fs::File;
use std::io;
use std::io::{BufReader, BufWriter, Error, Read, Write};
use std::path::Path;
use std::time::SystemTime;
use walkdir::WalkDir;
use zip::{write::FileOptions, CompressionMethod, DateTime, ZipArchive};

/// 拷贝分块大小（1MB）：按块读写以便在长任务中途推进进度
const COPY_CHUNK: usize = 1024 * 1024;

/// 取文件修改时间对应的 zip 时间戳
///
/// zip 的 `FileOptions::default()` 时间戳是 1980-01-01，不逐文件写入的话，
/// 「打包上传 → 服务端解压」后所有文件时间都会变成 1980 年（【核对程序集】会全部报时间不一致）。
///
/// 注意：zip 的 DOS 时间戳没有时区信息，解压端会按**服务器本地时区**解释，
/// 所以这里必须按本机本地时间取分量写入（此前误用 UTC，导致服务端时间整体偏了时区差）。
/// 另受 DOS 时间 2 秒精度限制，奇数秒会被解压端截为偶数秒（-1 秒）。
fn zip_last_modified(path: &Path) -> Option<DateTime> {
    let modified = path.metadata().ok()?.modified().ok()?;
    let secs = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    let dt = Local.timestamp_opt(secs, 0).single()?;
    DateTime::from_date_and_time(
        dt.year() as u16,
        dt.month() as u8,
        dt.day() as u8,
        dt.hour() as u8,
        dt.minute() as u8,
        dt.second() as u8,
    )
    .ok()
}

/// 为单个文件生成带修改时间的压缩选项（FileOptions 为 Copy，可逐文件生成）
pub fn with_mtime(options: FileOptions, path: &Path) -> FileOptions {
    match zip_last_modified(path) {
        Some(time) => options.last_modified_time(time),
        None => options,
    }
}

///
/// 预扫描待压缩的文件数量与总字节数（作为进度分母）
///
/// # Arguments
/// * `file_paths` - 文件|文件夹路径
///
/// # Returns
/// * `(文件数量, 总字节数)`；任一路径不存在时该路径按 0 计入
pub fn scan_zip_sources(file_paths: &[&str]) -> (u32, u64) {
    let mut file_total: u32 = 0;
    let mut total_bytes: u64 = 0;
    for file_path in file_paths {
        let src_path = Path::new(file_path);
        if src_path.is_file() {
            file_total += 1;
            total_bytes += src_path.metadata().map(|m| m.len()).unwrap_or(0);
        } else if src_path.is_dir() {
            for entry in WalkDir::new(src_path).into_iter().filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    file_total += 1;
                    total_bytes += path.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    (file_total, total_bytes)
}

///
/// 分块拷贝并推送进度
///
/// # Arguments
/// * `reader` - 源
/// * `writer` - 目标（zip writer）
/// * `file_name` - 当前文件名（用于展示）
/// * `file_index` / `file_total` - 文件序号（1-based）/ 总数
/// * `processed` - 累计已处理字节（跨文件累加）
/// * `total_bytes` - 总字节（0 表示未知）
/// * `progress` - 进度推送器（None 时不推送）
#[allow(clippy::too_many_arguments)]
pub fn copy_with_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    file_name: &str,
    file_index: u32,
    file_total: u32,
    processed: &mut u64,
    total_bytes: u64,
    mut progress: Option<&mut ProgressState>,
) -> io::Result<()> {
    let mut buffer = vec![0u8; COPY_CHUNK];
    loop {
        let read_len = reader.read(&mut buffer)?;
        if read_len == 0 {
            break;
        }
        writer.write_all(&buffer[..read_len])?;
        *processed += read_len as u64;
        if let Some(progress) = &mut progress {
            progress.emit("zip", file_name, *processed, total_bytes, file_index, file_total);
        }
    }
    if let Some(progress) = progress {
        progress.emit("zip", file_name, *processed, total_bytes, file_index, file_total);
    }
    Ok(())
}

///
/// 创建压缩文件
///
/// # Arguments
/// * `file_paths` - 文件|文件夹路径
/// * `dst_file` - 输出的zip文件路径
/// * `progress` - 进度推送器（None 表示不推送）
///
/// # Returns
/// * `ZipResult` 压缩结果
pub fn create_zip(
    file_paths: &[&str],
    dst_file: &str,
    mut progress: Option<&mut ProgressState>,
) -> zip::result::ZipResult<()> {
    let zip_file = File::create(dst_file)?;
    let mut zip = zip::ZipWriter::new(BufWriter::new(zip_file));

    let options = FileOptions::default()
        .compression_method(CompressionMethod::Stored) // 你可以改变压缩方法
        .unix_permissions(0o755);

    // 进度分母：预扫描文件数与总字节（扫描失败退化为 0，退化为不定长展示）
    let (file_total, total_bytes) = scan_zip_sources(file_paths);
    let mut file_index: u32 = 0;
    let mut processed: u64 = 0;

    for file_path in file_paths {
        let src_path = Path::new(file_path);

        if src_path.is_file() {
            // 处理单个文件
            let name = src_path.file_name().unwrap().to_str().unwrap();
            file_index += 1;
            zip.start_file(name, with_mtime(options, src_path))?;
            let mut f = File::open(src_path)?;
            copy_with_progress(
                &mut f,
                &mut zip,
                src_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(name),
                file_index,
                file_total,
                &mut processed,
                total_bytes,
                progress.as_deref_mut(),
            )?;
        } else if src_path.is_dir() {
            // 处理整个目录
            let dir_name = src_path.file_name().unwrap().to_str().unwrap();
            for entry in WalkDir::new(src_path) {
                match entry {
                    Ok(entry) => {
                        let path = entry.path();
                        let name = path.strip_prefix(src_path).unwrap().to_str().unwrap();
                        if path.is_file() {
                            file_index += 1;
                            zip.start_file(format!("{}/{}", dir_name, name), with_mtime(options, path))?;
                            let mut f = File::open(path)?;
                            copy_with_progress(
                                &mut f,
                                &mut zip,
                                path.file_name().and_then(|n| n.to_str()).unwrap_or(name),
                                file_index,
                                file_total,
                                &mut processed,
                                total_bytes,
                                progress.as_deref_mut(),
                            )?;
                        } else if path.is_dir() {
                            zip.add_directory(
                                format!("{}/{}", dir_name, name),
                                with_mtime(options, path),
                            )?;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error walking directory: {}", e);
                        return Err(zip::result::ZipError::FileNotFound);
                    }
                }
            }
        } else {
            return Err(zip::result::ZipError::FileNotFound);
        }
    }
    zip.finish()?;
    if let Some(progress) = progress {
        progress.emit_force("zip", "", processed, total_bytes, file_index, file_total);
    }
    Ok(())
}

///
/// 解压压缩文件
///
/// # Arguments
/// * `file_paths` - 文件路径
/// * `destination` - 输出解压路径
///
/// # Returns
/// * `OK(true)` 成功
/// * `Err` 失败
pub fn unzip_files(file_paths: &[&str], destination: &str) -> Result<bool, Error> {
    for file_path in file_paths {
        // 打开 zip 文件
        let file = File::open(file_path)?;
        let mut archive = ZipArchive::new(BufReader::new(file))?;

        // 遍历 archive 中的所有文件
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let outpath = Path::new(destination).join(file.name());

            // 如果文件有上级目录，则进行目录创建
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // 判断是否为目录
            if file.name().ends_with('/') {
                std::fs::create_dir_all(&outpath)?;
            } else {
                // 创建文件并写入内容
                let mut outfile = File::create(&outpath)?;
                std::io::copy(&mut file, &mut outfile)?;
            }

            // 设置权限（在 Unix 系统上生效）
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode))?;
                }
            }
        }
    }
    Ok(true)
}

///
/// 读取文件目录中的文件
///
/// # Arguments
/// * `path` - 文件目录
///
/// # Returns
/// * `OK` 成功
/// * `Err` 失败
pub fn read_dir_files(path: &str) -> io::Result<Vec<String>> {
    let mut file_names = Vec::new();
    let path = Path::new(path);
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() {
                if let Some(file_name) = path.file_name() {
                    if let Some(file_name_str) = file_name.to_str() {
                        file_names.push(file_name_str.to_string());
                    }
                }
            }
        }
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "提供的路径不是目录.",
        ));
    }

    Ok(file_names)
}
