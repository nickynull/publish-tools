import { removeSlash } from "@/utils/other";

/**
 * 服务器日志（服务器上的操作日志文件）读取与下载支持
 *
 * 四类日志由 STEP 发布流程写入（useStepPublish.ts 的 appendRemoteLogLine）：
 *   备份 / 恢复 → <服务备份路径>/备份日志.log、恢复日志.log
 *   上传 / 发布 → <程序集暂存路径>/上传日志.log、发布日志.log
 * 本模块只负责：路径解析 + 远端命令构造 + 本地文件名，实际执行复用既有
 * execute_remote_command / download_server_files 命令，无需新增 Rust 命令。
 */

/** 日志类型 */
export type ServerLogType = "backup" | "restore" | "upload" | "publish";

export type ServerLogOption = {
	/** 类型标识（下拉菜单 command 值） */
	type: ServerLogType;
	/** 展示名称：备份日志 */
	label: string;
	/** 日志文件名 */
	fileName: string;
	/** 路径字段：服务备份路径 / 程序集暂存路径 */
	pathField: "serviceBackupPath" | "assemblyStagingPath";
	/** 路径字段中文名（未配置提示用） */
	pathFieldLabel: string;
};

/** 下拉可选的四类日志（顺序即菜单顺序） */
export const SERVER_LOG_OPTIONS: ServerLogOption[] = [
	{ type: "backup", label: "备份日志", fileName: "备份日志.log", pathField: "serviceBackupPath", pathFieldLabel: "服务备份路径" },
	{ type: "restore", label: "恢复日志", fileName: "恢复日志.log", pathField: "serviceBackupPath", pathFieldLabel: "服务备份路径" },
	{ type: "upload", label: "上传日志", fileName: "上传日志.log", pathField: "assemblyStagingPath", pathFieldLabel: "程序集暂存路径" },
	{ type: "publish", label: "发布日志", fileName: "发布日志.log", pathField: "assemblyStagingPath", pathFieldLabel: "程序集暂存路径" },
];

/** 日志文件不存在的标记（命令必定 exit 0，避免后端非 0 退出码触发重试） */
export const SERVER_LOG_MISSING = "__SMOM_LOG_MISSING__";
/** 读取日志异常的前缀（Windows PowerShell catch 分支输出） */
export const SERVER_LOG_ERROR = "__SMOM_LOG_ERROR__";

/** 取日志类型配置 */
export const getServerLogOption = (type: ServerLogType): ServerLogOption =>
	SERVER_LOG_OPTIONS.find((opt) => opt.type === type) ?? SERVER_LOG_OPTIONS[0];

/** Windows 服务器（os=1）；其余按 Linux/Docker 处理（os=2） */
const isWindowsServer = (os: number) => Number(os) === 1;

/** POSIX 单引号字符串转义 */
const escapePosix = (path: string) => path.replace(/'/g, `'\\''`);
/** PowerShell 单引号字面量转义 */
const escapePowerShell = (path: string) => path.replace(/'/g, "''");

/**
 * 把 PowerShell 脚本编码为 -EncodedCommand 需要的 UTF-16LE base64
 * Windows 经 sshd 默认 shell（GBK 代码页）传中文会乱码，日志文件名含中文，
 * 因此不能直接把脚本拼进 -Command（与 useStepPublish.appendRemoteLogLine 同一做法）
 */
const toPowerShellEncodedScript = (script: string): string => {
	const bytes = new Uint8Array(
		new Uint16Array(Array.from(script).map((c) => c.charCodeAt(0))).buffer
	);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
};

/** 组装 Windows 下的 powershell 调用（-EncodedCommand 形式） */
const buildPowerShellCommand = (script: string) =>
	`powershell -NoProfile -EncodedCommand ${toPowerShellEncodedScript(script)}`;

export type ServerLogTarget =
	| { ok: true; option: ServerLogOption; basePath: string; remotePath: string }
	| { ok: false; message: string };

/**
 * 解析某服务器某类日志的远端完整路径
 * 路径字段未配置（或为空）时返回失败与提示文案，调用方直接提示用户去「修改」补录
 */
export function resolveServerLogTarget(
	server: Pick<RowServerType, "serviceBackupPath" | "assemblyStagingPath">,
	type: ServerLogType
): ServerLogTarget {
	const option = getServerLogOption(type);
	const basePath = removeSlash(String(server[option.pathField] ?? "").trim());
	if (!basePath) {
		return { ok: false, message: `该服务器未配置${option.pathFieldLabel}，请先在【修改】中补录后再查看${option.label}` };
	}
	return { ok: true, option, basePath, remotePath: `${basePath}/${option.fileName}` };
}

/**
 * 读取日志末尾若干行的远端命令
 * - Windows：PowerShell Get-Content -Tail（显式 UTF8 读写，避免中文乱码）
 * - Linux/Docker：tail -n
 * 两者均必定 exit 0；文件不存在输出 SERVER_LOG_MISSING 标记
 */
export function buildRemoteLogTailCommand(os: number, remotePath: string, lines = 100): string {
	const path = removeSlash(remotePath);
	if (isWindowsServer(os)) {
		const script =
			`[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p='${escapePowerShell(path)}'; ` +
			`if (-not (Test-Path -LiteralPath $p)) { '${SERVER_LOG_MISSING}' } ` +
			`else { try { Get-Content -LiteralPath $p -Tail ${lines} -Encoding UTF8 } ` +
			`catch { '${SERVER_LOG_ERROR} ' + $_.Exception.Message } }`;
		return buildPowerShellCommand(script);
	}
	return `if [ -f '${escapePosix(path)}' ]; then tail -n ${lines} '${escapePosix(path)}'; else echo '${SERVER_LOG_MISSING}'; fi`;
}

/** 探测日志文件是否存在的远端命令（输出 1/0，必定 exit 0） */
export function buildRemoteLogExistsCommand(os: number, remotePath: string): string {
	const path = removeSlash(remotePath);
	if (isWindowsServer(os)) {
		return buildPowerShellCommand(
			`if (Test-Path -LiteralPath '${escapePowerShell(path)}') { '1' } else { '0' }`
		);
	}
	return `if [ -f '${escapePosix(path)}' ]; then echo '1'; else echo '0'; fi`;
}

/** 本地保存文件名：<服务器名>_<日志名>_<时间戳>.log（服务器名过滤 Windows 非法字符） */
export function buildLogFileName(serverName: string, type: ServerLogType, timestamp: string): string {
	const safeName = String(serverName || "server").replace(/[\\/:*?"<>|]/g, "_");
	return `${safeName}_${getServerLogOption(type).label}_${timestamp}.log`;
}
