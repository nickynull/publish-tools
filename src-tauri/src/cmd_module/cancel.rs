// 发布功能全局取消标记
//
// 设计目标：前端「停止」请求后，后端正在执行的重试循环、等待轮询、
// SSH 建连等应立即中断，而不是等当前步骤自然结束。
//
// 使用方式：
// - 前端通过 `set_publish_cancel` 命令置位/复位；
// - 各重试循环在每次尝试前、每次 sleep 前调用 `check_cancelled()`，
//   已取消则立即返回 `Err(CANCELLED_MSG)`，不再重试、不再等待。
//
// 说明：标记为全局静态，仅在发布功能运行期间会被置位，
// 每次运行开始（前端 resetStopState）即复位，泄漏窗口极小。

use std::sync::atomic::{AtomicBool, Ordering};

static PUBLISH_CANCEL: AtomicBool = AtomicBool::new(false);

/// 文件管理（上传/浏览/删除）独立取消标记
///
/// 与发布停止标记分开，避免「文件管理点终止」误停正在进行的发布，
/// 也避免「发布点停止」误停文件管理。仅文件管理弹窗发起的上传/删除使用。
static FILE_OP_CANCEL: AtomicBool = AtomicBool::new(false);

/// 已取消时的标准错误文案（前端日志据此识别为主动停止）
pub const CANCELLED_MSG: &str = "已手动停止";

/// 文件操作被终止时的标准错误文案（与发布停止区分，前端据此标记「已终止」）
pub const FILE_OP_CANCELLED_MSG: &str = "已手动终止";

/// 置位/复位文件操作取消标记
pub fn set_file_cancel(cancel: bool) {
    FILE_OP_CANCEL.store(cancel, Ordering::SeqCst);
}

/// 文件操作是否已请求终止
pub fn is_file_cancelled() -> bool {
    FILE_OP_CANCEL.load(Ordering::SeqCst)
}

/// 置位/复位取消标记
pub fn set_cancel(cancel: bool) {
    PUBLISH_CANCEL.store(cancel, Ordering::SeqCst);
}

/// 是否已请求取消
pub fn is_cancelled() -> bool {
    PUBLISH_CANCEL.load(Ordering::SeqCst)
}

/// 已取消则返回 Err，否则返回 Ok（供重试循环逐次检查）
pub fn check_cancelled() -> Result<(), String> {
    if is_cancelled() {
        return Err(CANCELLED_MSG.to_string());
    }
    Ok(())
}

/// 文件操作已终止则返回 Err，否则返回 Ok
pub fn check_file_cancelled() -> Result<(), String> {
    if is_file_cancelled() {
        return Err(FILE_OP_CANCELLED_MSG.to_string());
    }
    Ok(())
}

/// 分段 sleep 的共用实现：每 200ms 检查一次指定标记，
/// 标记置位则提前返回 false（未置位且等待完成返回 true）。
fn sleep_watching(total: std::time::Duration, flag: &AtomicBool) -> bool {
    let step = std::time::Duration::from_millis(200);
    let mut remaining = total;
    while remaining > std::time::Duration::ZERO {
        if flag.load(Ordering::SeqCst) {
            return false;
        }
        let slice = remaining.min(step);
        std::thread::sleep(slice);
        remaining -= slice;
    }
    !flag.load(Ordering::SeqCst)
}

/// 分段 sleep：等待期间检查发布取消标记
pub fn sleep_with_cancel(total: std::time::Duration) -> bool {
    sleep_watching(total, &PUBLISH_CANCEL)
}

/// 分段 sleep：等待期间检查文件操作取消标记
pub fn sleep_with_file_cancel(total: std::time::Duration) -> bool {
    sleep_watching(total, &FILE_OP_CANCEL)
}

/// 设置发布取消标记（前端「停止」按钮调用）
#[tauri::command]
pub fn set_publish_cancel(cancel: bool) -> Result<(), String> {
    set_cancel(cancel);
    Ok(())
}

/// 设置文件操作取消标记（前端文件管理弹窗「终止操作」调用）
#[tauri::command]
pub fn set_file_op_cancel(cancel: bool) -> Result<(), String> {
    set_file_cancel(cancel);
    Ok(())
}
