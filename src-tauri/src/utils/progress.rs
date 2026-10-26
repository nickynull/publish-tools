// 文件传输/压缩进度事件推送
//
// 设计目标：下载大文件、压缩大目录时，后端能把「已处理多少」实时回推前端，
// 避免界面长时间停留在「开始 → 结束」两行日志上。
//
// 使用方式：
// - 调用方构造 `ProgressState::new(Some(&app))`，在处理循环中调用 `emit`；
// - `emit` 内置 100ms 节流，事件风暴会拖垮前端渲染，非结束态的高频调用会被丢弃；
// - 收尾用 `emit_force` 保证 100% 的最终值一定送达；
// - Rust 内部直调（无 AppHandle）用 `ProgressState::none()`，推送静默丢弃。
//
// 事件负载：`{ kind: download|zip, file: 当前文件名, current: 已处理字节,
//             total: 总字节(0 表示未知), percent: 0~100, fileIndex: 第几个文件, fileTotal: 共几个文件 }`

use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 进度事件名（前端 listen 后写入界面日志）
pub const PROGRESS_EVENT: &str = "file-progress";

/// 相邻两次推送的最小间隔
const MIN_INTERVAL: Duration = Duration::from_millis(100);

pub struct ProgressState {
    app: Option<AppHandle>,
    last_emit: Option<Instant>,
    min_interval: Duration,
}

impl ProgressState {
    /// 绑定窗口句柄的进度推送器
    pub fn new(app: Option<&AppHandle>) -> Self {
        Self {
            app: app.cloned(),
            last_emit: None,
            min_interval: MIN_INTERVAL,
        }
    }

    /// 无窗口句柄的进度推送器：所有推送静默丢弃
    pub fn none() -> Self {
        Self {
            app: None,
            last_emit: None,
            min_interval: MIN_INTERVAL,
        }
    }

    /// 推送进度（节流：距上次推送不足 min_interval 且未完成时丢弃）
    pub fn emit(
        &mut self,
        kind: &str,
        file: &str,
        current: u64,
        total: u64,
        file_index: u32,
        file_total: u32,
    ) {
        self.emit_inner(kind, file, current, total, file_index, file_total, false);
    }

    /// 强制推送：不受节流限制，用于收尾的 100%
    pub fn emit_force(
        &mut self,
        kind: &str,
        file: &str,
        current: u64,
        total: u64,
        file_index: u32,
        file_total: u32,
    ) {
        self.emit_inner(kind, file, current, total, file_index, file_total, true);
    }

    fn emit_inner(
        &mut self,
        kind: &str,
        file: &str,
        current: u64,
        total: u64,
        file_index: u32,
        file_total: u32,
        force: bool,
    ) {
        let finished = total > 0 && current >= total;
        if !force && !finished {
            if let Some(last) = self.last_emit {
                if last.elapsed() < self.min_interval {
                    return;
                }
            }
        }
        let app = match &self.app {
            Some(app) => app,
            None => return,
        };
        let percent = if total > 0 {
            let raw = current as f64 / total as f64 * 100.0;
            (raw.min(100.0) * 10.0).round() / 10.0
        } else {
            0.0
        };
        let _ = app.emit(
            PROGRESS_EVENT,
            serde_json::json!({
                "kind": kind,
                "file": file,
                "current": current,
                "total": total,
                "percent": percent,
                "fileIndex": file_index,
                "fileTotal": file_total,
            }),
        );
        self.last_emit = Some(Instant::now());
    }
}
