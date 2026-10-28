import { removeSlash } from "@/utils/other";

/**
 * 远端文件系统操作（存在性探测 / 删除）的命令构造
 *
 * 与 serverLog.ts 的日志探测同源：Windows 远程命令含中文必须走
 * `powershell -NoProfile -EncodedCommand`（UTF-16LE base64），
 * 否则经 sshd 默认 shell（GBK 代码页）会解坏路径；
 * 命令一律「必定 exit 0 + 输出标记」，避免 execute_remote_command
 * 遇到非 0 退出码重试 3 次并推 backend-retry 日志。
 */

/** 删除成功标记 */
export const REMOTE_OP_OK = "OK";
/** 删除失败标记前缀（后接原因） */
export const REMOTE_OP_ERROR = "ERR";

/** Windows 服务器（os=1）；其余按 Linux/Docker 处理（os=2） */
export const isWindowsServer = (os: number) => Number(os) === 1;

/** POSIX 单引号字符串转义 */
export const escapePosix = (path: string) => path.replace(/'/g, `'\\''`);

/** PowerShell 单引号字面量转义 */
export const escapePowerShellLiteral = (path: string) => path.replace(/'/g, "''");

/** 把 PowerShell 脚本编码为 -EncodedCommand 需要的 UTF-16LE base64 */
export const toPowerShellEncodedScript = (script: string): string => {
	const bytes = new Uint8Array(
		new Uint16Array(Array.from(script).map((c) => c.charCodeAt(0))).buffer
	);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
};

/** 组装 Windows 下的 powershell 调用（-EncodedCommand 形式） */
export const buildPowerShellEncodedCommand = (script: string) =>
	`powershell -NoProfile -EncodedCommand ${toPowerShellEncodedScript(script)}`;

/**
 * 拼接远端路径（统一正斜杠）
 *
 * 与 serverLog 的日志路径拼接保持一致：Windows 远端用正斜杠同样有效
 * （OpenSSH sftp / PowerShell Test-Path、Remove-Item 均接受），
 * 统一成一种分隔符可避免混用 `\` 与 `/` 造成的重复或缺失分隔。
 *
 * @param base 基础目录（可带尾部分隔符）
 * @param segments 追加的分段（自动去掉首尾分隔符）
 */
export function joinRemotePath(base: string, ...segments: string[]): string {
	const root = removeSlash(String(base ?? "").trim());
	const tail = segments
		.map((segment) => String(segment ?? "").trim().replace(/^\/+|\/+$/g, ""))
		.filter(Boolean)
		.join("/");
	if (!tail) return root;
	return root ? `${root}/${tail}` : tail;
}

/**
 * 探测远端目录是否存在的命令（输出 1/0，必定 exit 0）
 * @param os 服务环境（1=Windows，2=Docker）
 * @param remotePath 远端目录路径
 */
export function buildRemoteDirExistsCommand(os: number, remotePath: string): string {
	const path = removeSlash(remotePath);
	if (isWindowsServer(os)) {
		return buildPowerShellEncodedCommand(
			`if (Test-Path -LiteralPath '${escapePowerShellLiteral(path)}' -PathType Container) { '1' } else { '0' }`
		);
	}
	return `if [ -d '${escapePosix(path)}' ]; then echo 1; else echo 0; fi`;
}

/**
 * 字节数格式化为易读文本（B / KB / MB / GB）
 * @param bytes 字节数
 */
export function formatFileSize(bytes: number): string {
	const size = Number(bytes ?? 0);
	if (!Number.isFinite(size) || size <= 0) return "—";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = size;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return unitIndex === 0 ? `${value} ${units[unitIndex]}` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 删除远端文件/目录的命令（输出 OK 或 "ERR <原因>"，必定 exit 0）
 * 目录按递归删除处理（`Remove-Item -Recurse` / `rm -rf`），不要求先清空。
 * @param os 服务环境（1=Windows，2=Docker）
 * @param remotePath 远端路径
 */
export function buildRemoteDeleteCommand(os: number, remotePath: string): string {
	const path = removeSlash(remotePath);
	if (isWindowsServer(os)) {
		return buildPowerShellEncodedCommand(
			`[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { ` +
				`Remove-Item -LiteralPath '${escapePowerShellLiteral(path)}' -Recurse -Force -ErrorAction Stop; ` +
				`'${REMOTE_OP_OK}' } catch { '${REMOTE_OP_ERROR} ' + $_.Exception.Message }`
		);
	}
	return `if rm -rf -- '${escapePosix(path)}' 2>/dev/null; then echo ${REMOTE_OP_OK}; else echo "${REMOTE_OP_ERROR} 删除失败"; fi`;
}
