use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::cmd_module::cancel::{is_cancelled, CANCELLED_MSG};

/// 编译项目
///
/// # Arguments
/// * `project_file_path` - 项目文件路径
/// * `msbuild_path` - MSBuild编译路径
/// * `is_rebuild` - 是否重新编译
///
/// # Returns
/// * `Ok(())` 成功
/// * `Err(String)` 失败，返回 MSBuild 错误输出
pub fn build_project(
    project_file_path: &str,
    msbuild_path: &str,
    is_rebuild: bool,
    build_mode: &str,
) -> Result<(), String> {
    let mut command = Command::new(msbuild_path);

    // 编译目标：Rebuild 或 Build
    if is_rebuild {
        command.arg("/t:Rebuild");
    } else {
        command.arg("/t:Build");
    }

    let configuration = format!("/p:Configuration={}", build_mode);

    let output = command
        .arg(project_file_path)
        .arg("/restore")
        .arg(&configuration)
        .arg("/m")
        // 关闭节点复用：否则 /m 拉起的 worker 节点在编译结束后仍常驻 15 分钟，反复编译会不断累积
        .arg("/nodeReuse:false")
        .arg("/v:quiet")
        .arg("/clp:ErrorsOnly")
        // 环境变量覆盖整棵子进程树（含 /restore 独立进程）
        .env("MSBUILDDISABLENODEREUSE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("启动 MSBuild 进程失败: {}", e))?;

    if output.status.success() {
        println!("编译 【{}】 成功.", project_file_path);
        Ok(())
    } else {
        // 过滤输出，只保留包含错误/警告的行，去掉 MSBuild 版本横幅等无关信息
        let all_output = String::from_utf8_lossy(&output.stdout).to_string();
        let fallback_output = String::from_utf8_lossy(&output.stderr).to_string();

        let final_msg = all_output
            .lines()
            .chain(fallback_output.lines())
            .filter(|line| line.contains(": error"))
            .map(|line| line.trim())
            .collect::<Vec<_>>()
            .join("\n");

        let final_msg = if !final_msg.is_empty() {
            final_msg
        } else {
            "编译失败，但未捕获到错误输出。请检查 MSBuild 路径或项目配置。".to_string()
        };

        eprintln!("编译 【{}】 失败: {}", project_file_path, final_msg);
        Err(final_msg)
    }
}

/// 读空子进程管道（读取线程内调用，避免管道写满阻塞 MSBuild）
fn read_pipe<R: Read>(reader: Option<R>) -> String {
    let mut bytes = Vec::new();
    if let Some(mut r) = reader {
        let _ = r.read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).to_string()
}

/// 从 MSBuild 输出中提取错误行（无 error 行时回退到输出末尾几行）
fn collect_build_errors(stdout: &str, stderr: &str) -> String {
    let errors = stdout
        .lines()
        .chain(stderr.lines())
        .filter(|line| line.contains(": error"))
        .map(|line| line.trim())
        .collect::<Vec<_>>()
        .join("\n");

    if !errors.is_empty() {
        return errors;
    }

    // 未捕获到 error 行（如 MSBuild 异常退出、参数错误）：回退输出末尾 5 行，便于定位
    let tail = stdout
        .lines()
        .chain(stderr.lines())
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let tail = tail
        .iter()
        .skip(tail.len().saturating_sub(5))
        .copied()
        .collect::<Vec<_>>()
        .join("\n");

    if tail.is_empty() {
        "编译失败，但未捕获到错误输出。请检查 MSBuild 路径或解决方案配置。".to_string()
    } else {
        format!("编译失败（未捕获到 error 行），输出末尾：\n{}", tail)
    }
}

/// 编译解决方案（STEP【编译解决方案】使用）
///
/// 与 `build_project` 的差异：
/// - 编译目标是整个 `.sln`：一次 MSBuild 调用编译解决方案内的全部项目，不再逐个 csproj 编译；
/// - 支持指定平台（`/p:Platform`，留空表示交给解决方案自身配置）；
/// - 编译期间轮询发布取消标记，前端点【停止】可立即结束 MSBuild 进程（大解决方案编译耗时长）。
///
/// # Arguments
/// * `solution_path` - 解决方案文件路径（.sln）
/// * `msbuild_path` - MSBuild 编译路径
/// * `is_rebuild` - 是否重新编译（Rebuild / Build）
/// * `build_mode` - 生成模式（Release / Debug）
/// * `platform` - 平台（如 Any CPU / x64 / x86），留空则不传 `/p:Platform`
///
/// # Returns
/// * `Ok(())` 成功
/// * `Err(String)` 失败，返回错误行；被手动停止时返回 `CANCELLED_MSG`
pub fn build_solution(
    solution_path: &str,
    msbuild_path: &str,
    is_rebuild: bool,
    build_mode: &str,
    platform: &str,
) -> Result<(), String> {
    // 开始前已被停止（上一次操作残留的标记）：直接返回，不启动 MSBuild
    if is_cancelled() {
        return Err(CANCELLED_MSG.to_string());
    }

    let mut command = Command::new(msbuild_path);

    // 编译目标：Rebuild 或 Build
    if is_rebuild {
        command.arg("/t:Rebuild");
    } else {
        command.arg("/t:Build");
    }

    command.arg(solution_path).arg("/restore");
    command.arg(format!("/p:Configuration={}", build_mode));

    // 平台留空时不传，由解决方案自身的配置映射决定
    if !platform.trim().is_empty() {
        command.arg(format!("/p:Platform={}", platform.trim()));
    }

    command
        .arg("/m")
        // 关闭节点复用：否则 /m 拉起的 worker 节点常驻，反复编译会不断累积
        .arg("/nodeReuse:false")
        .arg("/v:quiet")
        .arg("/clp:ErrorsOnly")
        // 环境变量覆盖整棵子进程树（含 /restore 独立进程）
        .env("MSBUILDDISABLENODEREUSE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 MSBuild 进程失败: {}", e))?;

    // stdout / stderr 各起一个线程读空，主线程只负责轮询退出与取消标记
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || read_pipe(stdout));
    let stderr_handle = std::thread::spawn(move || read_pipe(stderr));

    let mut cancelled = false;
    let status = loop {
        // 用户点了【停止】：杀掉 MSBuild 进程（其拉起的子进程随节点复用关闭一并退出）
        if is_cancelled() {
            cancelled = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 MSBuild 进程失败: {}", e));
            }
        }
    };

    let all_output = stdout_handle.join().unwrap_or_default();
    let fallback_output = stderr_handle.join().unwrap_or_default();

    if cancelled {
        eprintln!("编译 【{}】 已被手动停止.", solution_path);
        return Err(CANCELLED_MSG.to_string());
    }

    match status {
        Some(status) if status.success() => {
            println!("编译解决方案 【{}】 成功.", solution_path);
            Ok(())
        }
        _ => {
            let final_msg = collect_build_errors(&all_output, &fallback_output);
            eprintln!("编译解决方案 【{}】 失败: {}", solution_path, final_msg);
            Err(final_msg)
        }
    }
}
