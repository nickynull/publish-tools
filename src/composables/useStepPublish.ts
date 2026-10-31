import { ref, onMounted, onUnmounted } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cmdInvoke } from "@/utils/command";
import { removeSlash, displayOs, formatServiceLog } from "@/utils/other";
import { formatDate, getRecentDaysDateRange } from "@/utils/formatTime";
import { isCommitSelectModel } from "@/utils/sourceControl";
import { useServerDb } from "@/database/servers/index";
import { useTfsDb } from "@/database/teamFoundationServer/index";
import { useGitDb } from "@/database/git/index";
import { getRetryArgs, getPublishModuleOrder, getServiceWaitTimeouts } from "@/utils/publishSettings";
import type { StepLogApi } from "./useStepLog";
import {
	outPublishContents,
	outDetaultPublishContents,
	outPublishContentByDates,
	outPublishContentByUsers,
	getDllFilesByChangedItems,
	getTfsChangedPath,
	type DllResolveOptions,
} from "@/utils/outPublishInfo";

/**
 * 项目发布(STEP) 业务组合式函数
 * 按钮能力：获取程序集、备份服务、打包wpf、上传程序集、服务管理、查看待发布程序集、发布
 * 说明：全部为新实现方法，不修改/调用 home 页内部逻辑，保证原有功能不受影响
 */

// 上下文：由页面提供响应式数据的读取器
export type StepPublishContext = {
	projectId: () => any;
	projectName: () => string;
	environment: () => number | null;
	appconfigData: () => RowAppconfigType;
	assemblyOutPath: () => string;
};

// STEP 模块定义
type StepModule = {
	name: string;
	clientPath: string | null;
	serverArr: SelectServerType[];
	hasService: boolean; // 是否有服务标识（WpfClient 仅上传文件，无服务启停）
};

// 服务实例定义
export type ServiceInstanceType = {
	module: string;
	serverId: number;
	serverName: string;
	identity: string;
	path: string;
};

// 服务状态行
export type ServiceStatusRow = {
	module: string;
	serverId: number;
	serverName: string;
	identity: string;
	statusText: string;
	running: boolean | null; // true 运行中 / false 已停止 / null 未知
};

// 服务操作类型
export type ServiceControlAction = "stop" | "start" | "restart";

// 待发布程序集行
export type StagingAssemblyRow = {
	serverName: string;
	moduleName: string;
	latestFileName: string;
	latestFileTime: string;
	oldestFileName: string;
	oldestFileTime: string;
};

// 程序集核对明细项类型：missing 服务器缺失 / timeDiff 修改时间不一致 / extra 服务器多出（本地已无）
export type AssemblyDiffDetail = {
	type: "missing" | "timeDiff" | "extra";
	file: string;
	localTime: string;
	serverTime: string;
};

// 时间比对容差（秒）：打包上传路径的 zip DOS 时间戳只有 2 秒精度，服务端 Expand-Archive 解压后
// 奇数秒会被舍成相邻偶数秒（±1s，格式限制无法消除），故比对放宽到 ±2 秒视为一致
const MTIME_TOLERANCE_SECONDS = 2;

// 整包上传的压缩包文件名：一次上传把本次所有待发布模块打进同一个包（同一模块组合多服务器复用一个包，故不带服务器标识）
const BATCH_ZIP_NAME = "_upload_batch.zip";

// 程序集核对行（每个服务器中每个程序集目录的差异统计）
export type AssemblyDiffRow = {
	serverId: number;
	serverName: string;
	moduleName: string;
	localCount: number; // 本地文件数
	serverCount: number; // 服务器文件数
	missingCount: number; // 服务器缺失文件数
	timeDiffCount: number; // 修改时间不一致数
	extraCount: number; // 服务器多出文件数（本地已无）
	diffCount: number; // 差异合计（缺失 + 时间不一致 + 服务器多出）
	consistent: boolean; // 是否一致（差异合计为 0）
	details: AssemblyDiffDetail[]; // 差异明细
};

// 服务备份行（每个服务器备份目录按名称降序前 10 个备份文件夹及其一级目录明细）
export type ServiceBackupRow = {
	serverId: number;
	serverName: string;
	backupBase: string; // 服务器服务备份路径（根目录）
	backupDate: string; // 备份文件夹名（如 2026102421 或 a_apihost）
	backupPath: string; // 备份文件夹完整路径（删除用）
	backupTime: string; // 文件夹修改时间（即备份时间）
	serviceCount: number; // 一级目录内服务（条目）数量
	services: string[]; // 一级目录内服务（条目）名称明细
};

const MODULE_NAMES = {
	webApiHost: "WebApiHost",
	scheduleServer: "ScheduleServer",
	webClient: "WebClient",
	spcMonitor: "SpcMonitor",
	wpfClient: "WpfClient",
};

export function useStepPublish(ctx: StepPublishContext, log: StepLogApi) {
	const { printInfoLog, updateLogProgress, setLogProgressText, logPrintInfo } = log;

	// 本地发布日志上下文（TFS/Git 生成发布日志使用，与 home 的 generatePublishLog 独立）
	const generatePublishLog = ref({
		isEnable: true,
		type: "默认",
		displayPublishField: {
			isChangeSet: true,
			isUser: true,
			isDateTime: true,
			isDll: true,
		} as DisplayPublishFieldType,
		data: "",
		logs: "",
	});

	const serverDb = useServerDb();
	const tfsDb = useTfsDb();
	const gitDb = useGitDb();

	// 手动停止标记（每次开始运行时重置；正在执行中的单条命令通过后端取消标记立即中断）
	const stopRequested = ref(false);
	let stopMessagePrinted = false;
	const requestStop = () => {
		stopRequested.value = true;
		// 同步置位后端取消标记：重试循环/等待轮询/SSH 建连立即中断
		cmdInvoke("set_publish_cancel", { cancel: true });
	};
	// 检查停止标记：已请求则提示一次并返回 true
	const checkStop = () => {
		if (!stopRequested.value) return false;
		if (!stopMessagePrinted) {
			stopMessagePrinted = true;
			printInfoLog("已手动停止，正在停止后续操作.", "log-warning");
		}
		return true;
	};
	// 运行开始时重置停止标记（同时复位后端取消标记）
	const resetStopState = () => {
		stopRequested.value = false;
		stopMessagePrinted = false;
		cmdInvoke("set_publish_cancel", { cancel: false });
	};

	// 获取程序集：TFS/Git 变更文件清单缓存（同一配置一次运行内只查询/解析一次）
	const assemblyFileListCache = new Map<string, string[]>();

	// ==================== 后端重试事件 → 界面日志 ====================
	// Rust 端命令重试时会 push "backend-retry" 事件，把它转成界面日志，避免只在控制台可见
	type BackendRetryPayload = {
		source?: string;
		attempt?: number;
		total?: number;
		willRetry?: boolean;
		message?: string;
	};
	let unlistenBackendRetry: UnlistenFn | null = null;
	// 同一功能的连续重试合并成一行（重试期间反复提示会刷屏）；行数裁剪会使下标前移，改用日志行 id 定位
	let retryLogId = -1;
	let retryLogKey = "";

	const handleBackendRetry = (payload: BackendRetryPayload) => {
		const source = payload.source || "后端命令";
		const message = payload.message || "";
		const attempt = payload.attempt || 0;
		const total = payload.total || 0;
		const willRetry = !!payload.willRetry;
		const key = `${source}|${message}`;

		const nowDate = `[${formatDate(new Date(), "YYYY-mm-dd HH:MM:SS")}] `;
		const text = willRetry
			? `${nowDate}  [重试] ${source}第 ${attempt}/${total} 次失败：${message}，${total - attempt} 次剩余，稍后自动重试...`
			: `${nowDate}  [重试] ${source}第 ${attempt}/${total} 次失败：${message}，已达最大重试次数.`;

		// 未开始任何功能时（重试不在运行上下文内）不打印，避免干扰空闲时的其它命令
		if (willRetry && key === retryLogKey && retryLogId >= 0) {
			// 连续同一错误：原地更新，避免多行刷屏
			const prevLog = logPrintInfo.value.find((l) => l.id === retryLogId);
			if (prevLog) {
				prevLog.content.value = text;
				return;
			}
		}
		// 最终失败用错误色记录，便于「失败日志」汇总；重试中为警告色
		retryLogId = printInfoLog(text.replace(nowDate, ""), willRetry ? "log-warning" : "log-error");
		retryLogKey = willRetry ? key : "";
	};

	// ==================== 后端进度事件 → 界面日志 ====================
	// Rust 端下载/压缩过程中推送 "file-progress"，实时写入当前进度日志行，避免长时间无反馈
	type FileProgressPayload = {
		kind?: string; // download | zip
		file?: string; // 当前文件名
		current?: number; // 已处理字节
		total?: number; // 总字节（0 表示未知）
		percent?: number; // 0~100
		fileIndex?: number; // 第几个文件（1-based）
		fileTotal?: number; // 共几个文件
	};
	let unlistenFileProgress: UnlistenFn | null = null;
	// 进度写入目标：调用下载/压缩前置位、结束后清除（下载与压缩均串行执行，不存在并发串台）；
	// 存日志行 id（printInfoLog 返回），行数裁剪后仍能正确定位
	let progressTarget: { logId: number } | null = null;
	// 进度文本前缀（如"已下载 2/5 个文件"），文件计数由调用方维护
	let progressPrefix = "";

	// 字节数格式化（B/KB/MB/GB/TB）
	const formatBytes = (bytes: number) => {
		if (!bytes || bytes < 0) return "0 B";
		const units = ["B", "KB", "MB", "GB", "TB"];
		let value = bytes;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value = value / 1024;
			unitIndex++;
		}
		return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
	};

	const handleFileProgress = (payload: FileProgressPayload) => {
		if (!progressTarget) return;
		const kind = payload.kind || "";
		const fileName = payload.file || "";
		const current = payload.current || 0;
		const total = payload.total || 0;
		const fileIndex = payload.fileIndex || 0;
		const fileTotal = payload.fileTotal || 0;
		let text = progressPrefix;
		if (kind === "download" || kind === "upload") {
			const sizeText =
				total > 0
					? `${(payload.percent ?? 0).toFixed(0)}%（${formatBytes(current)} / ${formatBytes(total)}）`
					: formatBytes(current);
			text = `${progressPrefix}${fileName ? `；${fileName} ` : ""}${sizeText}`;
		} else if (kind === "zip") {
			const countText = fileTotal > 0 ? `已压缩 ${fileIndex}/${fileTotal} 个文件` : "";
			const sizeText = total > 0 ? `（${formatBytes(current)} / ${formatBytes(total)}）` : "";
			text = `${progressPrefix}${countText}${sizeText}`;
		}
		setLogProgressText(progressTarget.logId, text);
	};

	// 设置进度写入目标
	const setProgressTarget = (logId: number, prefix: string) => {
		progressTarget = { logId };
		progressPrefix = prefix;
	};
	// 清除进度写入目标（后续事件不再写入）
	const clearProgressTarget = () => {
		progressTarget = null;
		progressPrefix = "";
	};

	onMounted(async () => {
		unlistenBackendRetry = await listen<BackendRetryPayload>("backend-retry", (event) => {
			handleBackendRetry(event.payload || {});
		});
		unlistenFileProgress = await listen<FileProgressPayload>("file-progress", (event) => {
			handleFileProgress(event.payload || {});
		});
	});
	onUnmounted(() => {
		unlistenBackendRetry?.();
		unlistenBackendRetry = null;
		unlistenFileProgress?.();
		unlistenFileProgress = null;
	});

	// ==================== 基础工具 ====================

	// 创建目录
	const createDir = async (path: string) => {
		const pathExists = await cmdInvoke("exists", { path });
		if (pathExists.code !== 0) {
			return await cmdInvoke("create_dir", { path });
		}
		return true;
	};

	// 查询服务信息
	const getServerDetail = async (id: number) => {
		let dataResult = await serverDb.getServerById(id);
		if (dataResult.code !== 0) {
			printInfoLog(dataResult.msg, "log-error");
			return null;
		}
		return dataResult.data.data;
	};

	// 查询Tfs信息
	const getTfsDetail = async (id: number) => {
		let dataResult = await tfsDb.getTfsById(id);
		if (dataResult.code !== 0) {
			printInfoLog(dataResult.msg, "log-error");
			return null;
		}
		return dataResult.data.data;
	};

	// 查询Git信息
	const getGitDetail = async (id: number) => {
		let dataResult = await gitDb.getGitById(id);
		if (dataResult.code !== 0) {
			printInfoLog(dataResult.msg, "log-error");
			return null;
		}
		return dataResult.data.data;
	};

	// 读取目录中的文件
	const readDirFiles = async (dirPath: string) => {
		const readFilesResult = await cmdInvoke("read_files", { path: dirPath });
		if (readFilesResult.code !== 0) {
			printInfoLog(readFilesResult.data, "log-error");
			return [];
		}
		return readFilesResult.data as string[];
	};

	// 执行远程命令（retryCount 不传时用后端默认的 3 次重试；探测类命令传 1，避免无谓重试与重试日志）
	const execRemote = (args: {
		username: string;
		password: string;
		server: string;
		command: string;
		retryCount?: number;
	}) => {
		return cmdInvoke("execute_remote_command", args);
	};

	// PowerShell 单引号字面量转义（路径/内容中的单引号需成对）
	const escapePowerShellLiteral = (text: string) => text.replace(/'/g, "''");
	// POSIX 单引号字面量转义（shell 单引号内单引号写成 '\''）
	const escapePosixLiteral = (text: string) => text.replace(/'/g, `'\\''`);
	// 组装 Windows 下的 PowerShell 调用（-EncodedCommand 形式）
	// Windows 经 sshd 默认 shell（GBK 代码页）传中文会乱码，暂存路径/日志内容可能含中文，必须编码后再传
	const buildPowerShellEncodedCommand = (script: string) => {
		// -EncodedCommand 期望 UTF-16LE 字节流的 base64（中文均为 BMP 字符，charCodeAt 可安全编码）
		const utf16leBytes = new Uint8Array(
			new Uint16Array(Array.from(script).map((c) => c.charCodeAt(0))).buffer
		);
		let binary = "";
		for (let i = 0; i < utf16leBytes.length; i++) binary += String.fromCharCode(utf16leBytes[i]);
		return `powershell -NoProfile -EncodedCommand ${btoa(binary)}`;
	};

	/**
	 * 向服务器日志文件追加一行（写入形式：最后追加新行，内容：[日期时间] + 操作信息）。
	 * 写日志失败仅打印 warning，不阻断备份/恢复/上传/发布主流程。
	 * Windows 经 sshd 默认 shell（GBK 代码页）传中文会乱码，统一走 powershell -EncodedCommand（UTF-16LE base64）；
	 * Linux sshd 原生 UTF-8，直接 printf 重定向追加（文件不存在自动创建）。
	 */
	const appendRemoteLogLine = async (params: {
		isWindows: boolean;
		username: string;
		password: string;
		server: string;
		logPath: string;
		line: string;
	}) => {
		const fullLine = `[${formatDate(new Date(), "YYYY-mm-dd HH:MM:SS")}] ${params.line}`;
		let result;
		if (params.isWindows) {
			// 单引号内英文单引号需成对转义（PowerShell 字符串字面量规则）
			const script = `Add-Content -LiteralPath '${escapePowerShellLiteral(params.logPath)}' -Value '${escapePowerShellLiteral(fullLine)}' -Encoding UTF8`;
			result = await execRemote({
				username: params.username,
				password: params.password,
				server: params.server,
				command: buildPowerShellEncodedCommand(script),
			});
		} else {
			// 单引号字符串内的单引号按 shell 规则转义为 '\''
			const escaped = fullLine.replace(/'/g, `'\\''`);
			result = await execRemote({
				username: params.username,
				password: params.password,
				server: params.server,
				command: `printf '%s\\n' '${escaped}' >> '${params.logPath}'`,
			});
		}
		if (result.code !== 0) {
			printInfoLog(`写入服务器日志失败（${params.logPath}）：${result.data}`, "log-warning");
		}
	};

	// 获取Dll日期范围
	const getDllModeDateRange = () => {
		let startDate = "";
		let endDate = "";
		const appconfigData = ctx.appconfigData();
		if (appconfigData.dllMode == "当天") {
			startDate = formatDate(new Date(), "YYYY-mm-dd 00:00:00");
			endDate = formatDate(new Date(), "YYYY-mm-dd 23:59:59");
		}
		if (appconfigData.dllMode == "最近3天") {
			const threeDaysAgo = new Date(new Date().getTime() - 3 * 24 * 60 * 60 * 1000);
			startDate = formatDate(threeDaysAgo, "YYYY-mm-dd 00:00:00");
			endDate = formatDate(new Date(), "YYYY-mm-dd 23:59:59");
		}
		if (appconfigData.dllMode == "日期范围") {
			const modeDates = JSON.parse(String(appconfigData.dllModeValue));
			startDate = modeDates[0];
			endDate = modeDates[1];
		}
		if (!startDate || !endDate) return [];
		return [startDate, endDate];
	};

	// 获取DLL名称模式
	const getDllModePatterns = () => {
		if (ctx.appconfigData().dllMode == "DLL名称") {
			return String(ctx.appconfigData().dllModeValue || "");
		}
		return "";
	};

	// 生成「获取范围」日志文案（按获取方式显示配置的范围）
	const getFetchRangeText = (): string => {
		const appconfigData = ctx.appconfigData();
		const mode = appconfigData.dllMode;
		if (mode === "TFS" || mode === "Git") {
			try {
				const item = JSON.parse(String(appconfigData.dllModeValue || "{}"));
				const selectModel = String(item.selectModel || "");
				const selectValue: Array<{ value?: string }> = Array.isArray(item.selectValue) ? item.selectValue : [];
				const beginValue = selectValue[0]?.value ? String(selectValue[0].value) : "";
				const endValue = selectValue[1]?.value ? String(selectValue[1].value) : "";
				if (selectModel === "日期") {
					const beginText = beginValue ? formatDate(new Date(beginValue), "YYYY-mm-dd HH:MM:SS") : "(未设置)";
					const endText = endValue ? formatDate(new Date(endValue), "YYYY-mm-dd HH:MM:SS") : "至今";
					return `日期：${beginText} ~ ${endText}`;
				}
				if (selectModel === "最近时间") {
					const recentRange = getRecentDaysDateRange(Number(beginValue));
					return recentRange.length === 2
						? `最近时间：最近 ${beginValue} 天（${recentRange[0]} ~ ${recentRange[1]}，每次获取动态计算）`
						: `最近时间：${beginValue || "(未设置)"} 天（天数无效）`;
				}
				if (isCommitSelectModel(selectModel)) {
					return `${selectModel}：${beginValue || "(未设置)"} ~ ${endValue || "最新"}`;
				}
				return selectModel || mode;
			} catch {
				return "(获取范围配置解析失败)";
			}
		}
		if (mode === "DLL名称") {
			const patterns = getDllModePatterns();
			return patterns ? `DLL名称：${patterns.replace(/\n|、/g, "、")}` : "DLL名称：(未配置)";
		}
		const dllModeDateRange = getDllModeDateRange();
		if (dllModeDateRange.length === 2) {
			return `${mode}（日期）：${dllModeDateRange[0]} ~ ${dllModeDateRange[1]}`;
		}
		return `${mode}：全部文件`;
	};

	// 毫秒转可读时长（获取程序集步骤日志用）
	const formatElapsed = (elapsedMs: number) => {
		return elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)} 秒` : `${elapsedMs} 毫秒`;
	};

	// ==================== 模块/实例定义 ====================

	// 获取参与 STEP 发布的模块（按应用配置中配置了[客户端生成路径]的模块）
	const getStepModules = (): StepModule[] => {
		const ci = ctx.appconfigData().configItems;
		const modules: StepModule[] = [];
		if (!ci) return modules;

		if (ci.webApiHost?.clientPath) {
			modules.push({ name: MODULE_NAMES.webApiHost, clientPath: ci.webApiHost.clientPath, serverArr: ci.webApiHost.serverArr || [], hasService: true });
		}
		if (ci.scheduleServer?.clientPath) {
			modules.push({ name: MODULE_NAMES.scheduleServer, clientPath: ci.scheduleServer.clientPath, serverArr: ci.scheduleServer.serverArr || [], hasService: true });
		}
		if (ci.webClient?.clientPath) {
			modules.push({ name: MODULE_NAMES.webClient, clientPath: ci.webClient.clientPath, serverArr: ci.webClient.serverArr || [], hasService: true });
		}
		if (ci.spcMonitor?.clientPath) {
			modules.push({ name: MODULE_NAMES.spcMonitor, clientPath: ci.spcMonitor.clientPath, serverArr: ci.spcMonitor.serverArr || [], hasService: true });
		}
		if (ci.wpfClient?.clientPath) {
			const wpfItem = ci.wpfClient;
			// 存量兼容：旧单服务器配置归一化为多服务器结构
			if ((!wpfItem.serverArr || wpfItem.serverArr.length < 1) && wpfItem.serverId) {
				wpfItem.serverIds = [wpfItem.serverId];
				wpfItem.serverArr = [
					{
						id: wpfItem.serverId,
						name: wpfItem.serverName,
						serverPathArr: [
							{
								label: "",
								value: [{ identity: "", path: wpfItem.serverPath || "" }],
							},
						],
					},
				];
			}
			modules.push({ name: MODULE_NAMES.wpfClient, clientPath: wpfItem.clientPath, serverArr: wpfItem.serverArr || [], hasService: false });
		}
		// 按设置页配置的发布模块顺序排序（顺序外的模块名排在末尾，保持原相对顺序）
		const order = getPublishModuleOrder();
		const rank = (name: string) => {
			const idx = order.indexOf(name);
			return idx === -1 ? order.length : idx;
		};
		return modules.sort((a, b) => rank(a.name) - rank(b.name));
	};

	// 收集服务实例
	const getServiceInstances = (modules?: StepModule[]): ServiceInstanceType[] => {
		const instances: ServiceInstanceType[] = [];
		for (const module of modules || getStepModules()) {
			for (const server of module.serverArr) {
				if (!server.id) continue;
				for (const serverPathGroup of server.serverPathArr || []) {
					for (const serverVal of serverPathGroup.value || []) {
						instances.push({
							module: module.name,
							serverId: Number(server.id),
							serverName: server.name || "",
							identity: serverVal.identity || "",
							path: serverVal.path || "",
						});
					}
				}
			}
		}
		return instances;
	};

	// 服务状态遍历顺序：服务器优先（按实例中首次出现的顺序），服务器内按发布模块顺序（顺序外的模块排末尾）
	const sortInstancesByServerThenModule = (instances: ServiceInstanceType[]): ServiceInstanceType[] => {
		const serverOrder: number[] = [];
		for (const ins of instances) {
			if (!serverOrder.includes(ins.serverId)) serverOrder.push(ins.serverId);
		}
		const moduleOrder = getPublishModuleOrder();
		const moduleRank = (name: string) => {
			const idx = moduleOrder.indexOf(name);
			return idx === -1 ? moduleOrder.length : idx;
		};
		// sort 稳定：同服务器同模块内的实例保持应用配置中的原顺序
		return [...instances].sort((a, b) => {
			const serverDiff = serverOrder.indexOf(a.serverId) - serverOrder.indexOf(b.serverId);
			return serverDiff !== 0 ? serverDiff : moduleRank(a.module) - moduleRank(b.module);
		});
	};

	// 校验实例路径
	const validateInstances = (instances: ServiceInstanceType[]) => {
		for (const ins of instances) {
			if (!ins.path) {
				printInfoLog(`服务[${ins.module} / ${ins.serverName}]存在未填写发布路径的实例，请检查应用配置.`, "log-error");
				return false;
			}
		}
		return true;
	};

	// ==================== 服务启停（STEP 独立实现） ====================

	// 验证[Windows]服务是否已关闭
	const isWinServiceStop = async (username: string, password: string, server: string, serviceName: string) => {
		const invokeResult = await execRemote({ username, password, server, command: `sc query "${serviceName}"` });
		if (invokeResult.data && String(invokeResult.data).includes("STOPPED")) {
			return true;
		}
		return false;
	};

	// 切换Windows服务（sc stop/start + 轮询等待目标状态）
	const switchWinService = async (
		username: string,
		password: string,
		server: string,
		serviceName: string,
		action: "stop" | "start"
	) => {
		const actionText = action === "stop" ? "停止" : "启动";
		const isStop = await isWinServiceStop(username, password, server, serviceName);
		if (action == "stop" && isStop) return true;
		if (action == "start" && !isStop) return true;

		const switchStartTime = Date.now();
		printInfoLog(`执行 sc ${action} "${serviceName}"（${server}）...`);
		const switchServerResult = await execRemote({
			username,
			password,
			server,
			command: `sc ${action} "${serviceName}"`,
			...getRetryArgs("service"),
		});
		if (switchServerResult.code !== 0) {
			printInfoLog(`sc ${action} "${serviceName}" 执行失败：${switchServerResult.data}`, "log-error");
			return false;
		}

		// sc 命令为非阻塞，需轮询确认状态；等待超时在设置页配置（启动默认 20 秒 / 停止默认 60 秒）；请求停止时立即中止轮询
		const retryInterval = 2000;
		const { startTimeoutSecs, stopTimeoutSecs } = getServiceWaitTimeouts();
		const timeoutSecs = action === "stop" ? stopTimeoutSecs : startTimeoutSecs;
		const maxRetries = Math.max(1, Math.ceil((timeoutSecs * 1000) / retryInterval));
		printInfoLog(`等待服务${actionText}确认（最长 ${timeoutSecs} 秒，每 ${retryInterval / 1000} 秒查询一次）...`);
		let pollCount = 0;
		for (let i = 0; i < maxRetries; i++) {
			await new Promise((resolve) => setTimeout(resolve, retryInterval));
			if (checkStop()) return false;
			pollCount++;
			const stopped = await isWinServiceStop(username, password, server, serviceName);
			if (action === "stop" && stopped) {
				printInfoLog(`已确认服务${actionText}（轮询 ${pollCount} 次，耗时 ${formatElapsed(Date.now() - switchStartTime)}）`);
				return true;
			}
			if (action === "start" && !stopped) {
				printInfoLog(`已确认服务${actionText}（轮询 ${pollCount} 次，耗时 ${formatElapsed(Date.now() - switchStartTime)}）`);
				return true;
			}
		}

		printInfoLog(`服务 ${serviceName} ${actionText}超时（已等待 ${timeoutSecs} 秒），请手动检查.`, "log-warning");
		return false;
	};

	// 切换Docker服务
	const switchDockerService = async (
		username: string,
		password: string,
		server: string,
		serviceName: string,
		action: "stop" | "start"
	) => {
		const switchStartTime = Date.now();
		printInfoLog(`执行 docker ${action} ${serviceName}（${server}）...`);
		const switchServerResult = await execRemote({
			username,
			password,
			server,
			command: `docker ${action} ${serviceName}`,
		});
		if (switchServerResult.code !== 0) {
			printInfoLog(`docker ${action} ${serviceName} 失败：${switchServerResult.data}`, "log-error");
			return false;
		}
		printInfoLog(`docker ${action} ${serviceName} 完成（耗时 ${formatElapsed(Date.now() - switchStartTime)}）`);
		return true;
	};

	// 停止服务实例（按部署环境分流）
	const stopInstanceService = async (server: RowServerType, instance: ServiceInstanceType) => {
		const serverAddress = `${server.ip}:${server.port}`;
		if (server.os === 1) {
			return await switchWinService(server.account, server.pwd, serverAddress, instance.identity, "stop");
		} else if (server.os === 2) {
			return await switchDockerService(server.account, server.pwd, serverAddress, instance.identity, "stop");
		}
		printInfoLog(`未找到 ${displayOs(Number(server.os))} 部署环境，请检查.`, "log-error");
		return false;
	};

	// 启动服务实例（按部署环境分流）
	const startInstanceService = async (server: RowServerType, instance: ServiceInstanceType) => {
		const serverAddress = `${server.ip}:${server.port}`;
		if (server.os === 1) {
			return await switchWinService(server.account, server.pwd, serverAddress, instance.identity, "start");
		} else if (server.os === 2) {
			return await switchDockerService(server.account, server.pwd, serverAddress, instance.identity, "start");
		}
		printInfoLog(`未找到 ${displayOs(Number(server.os))} 部署环境，请检查.`, "log-error");
		return false;
	};

	// 上传文件到服务器（带重试，读全局设置）
	const uploadServerFilesWithRetry = async (args: {
		localPaths: string[];
		remotePaths: string[];
		username: string;
		password: string;
		server: string;
	}) => {
		const { retryCount, retryIntervalSecs } = getRetryArgs("upload");
		const totalAttempts = Math.max(1, retryCount);
		let result = await cmdInvoke("upload_server_files", { ...args, retryCount: 1, retryIntervalSecs: 1 });
		for (let attempt = 1; attempt <= totalAttempts; attempt++) {
			if (result.code === 0) return result;
			if (attempt < totalAttempts) {
				// 请求停止时不再重试，立即返回失败结果
				if (checkStop()) return result;
				printInfoLog(
					`文件上传失败，${retryIntervalSecs}s 后重试（尝试 ${attempt}/${totalAttempts}）：${result.data}`,
					"log-warning"
				);
				await new Promise((resolve) => setTimeout(resolve, retryIntervalSecs * 1000));
				if (checkStop()) return result;
				result = await cmdInvoke("upload_server_files", { ...args, retryCount: 1, retryIntervalSecs: 1 });
			} else {
				printInfoLog(
					`文件上传失败，重试已用尽（尝试 ${attempt}/${totalAttempts}）：${result.data}`,
					"log-warning"
				);
			}
		}
		return result;
	};

	// ==================== 备份服务 ====================

	/**
	 * 备份服务：根据服务器配置的服务备份路径，在服务器上创建日期文件夹，
	 * 将所有服务整个目录拷贝进日期文件夹
	 */
	// 计算备份文件夹名：默认用目录名（最后一级），仅当同服务器内重名时逐级拼接上级目录直至唯一
	// 例：x/A x/B -> A B；x/y/A x/z/A -> y_A z_A；a/x/A b/x/A -> a_x_A b_x_A
	const computeBackupFolderNames = (instances: ServiceInstanceType[]) => {
		const pathSegments = instances.map((ins) =>
			removeSlash(ins.path).replace(/\\/g, "/").split("/").filter(Boolean)
		);
		const hasDuplicate = (names: string[]) => new Set(names).size !== names.length;
		const maxDepth = pathSegments.reduce((max, segs) => Math.max(max, segs.length), 1);
		let depth = 1;
		let names = pathSegments.map((segs) => segs.slice(segs.length - depth).join("_"));
		while (hasDuplicate(names) && depth < maxDepth) {
			depth++;
			names = pathSegments.map((segs) => segs.slice(segs.length - depth).join("_"));
		}
		return names;
	};

	const backupServices = async () => {
		resetStopState();
		const instances = getServiceInstances();
		if (instances.length < 1) {
			printInfoLog("应用配置中未找到任何服务，请检查.", "log-error");
			return false;
		}
		if (!validateInstances(instances)) return false;
		printInfoLog("");

		// 按服务器分组
		const serverMap = new Map<number, ServiceInstanceType[]>();
		for (const ins of instances) {
			const list = serverMap.get(ins.serverId) || [];
			list.push(ins);
			serverMap.set(ins.serverId, list);
		}

		const dateFolderName = formatDate(new Date(), "YYYYmmddHHMM");
		let isSuccess = true;

		// 入口信息
		const serverCount = serverMap.size;
		const totalServiceCount = [...serverMap.values()].reduce((sum, list) => sum + list.length, 0);
		printInfoLog(`备份方式：整目录拷贝到「年月日时分」文件夹（${dateFolderName}），文件夹已存在时先清空内容（防止残留已删除文件）`);
		printInfoLog(`备份文件夹命名：默认用目录名，仅同服务器内目录重名时拼接上级目录区分（如 x/y/A x/z/A -> y_A z_A）`);
		printInfoLog(`参与服务器：${serverCount} 台，共 ${totalServiceCount} 个服务实例`);
		const overallStartTime = Date.now();

		for (const [serverId, serverInstances] of serverMap) {
			if (checkStop()) return false;
			const serverInfo = await getServerDetail(serverId);
			if (!serverInfo) {
				printInfoLog(`服务[ID:${serverId}]不存在，请检查.`, "log-error");
				return false;
			}
			if (!serverInfo.serviceBackupPath) {
				printInfoLog(`服务器[${serverInfo.name}]未配置[服务备份路径]，请先在服务器管理中配置.`, "log-error");
				return false;
			}

			const serverStartTime = Date.now();
			const backupSuccess = await (async () => {
				const uName = serverInfo.account;
				const uPwd = serverInfo.pwd;
				const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;
				const backupBase = `${removeSlash(String(serverInfo.serviceBackupPath))}/${dateFolderName}`;
				printInfoLog(`服务器：${serverInfo.name}（${displayOs(Number(serverInfo.os))} ${serverAddress}）`);
				printInfoLog(
					`待备份服务（${serverInstances.length} 个）：${serverInstances
						.map((ins) => `${ins.module}(${ins.path})`)
						.join("、")}`
				);
				printInfoLog(`备份目标：${backupBase}`);

				// 创建日期文件夹（已存在则清空内容，防止同一时段重复备份时残留已删除文件）
				printInfoLog(`步骤 1/3：准备备份文件夹 ${backupBase}（不存在则创建；已存在则清空内容，防止残留已删除文件）...`);
				const mkdirStartTime = Date.now();
				let mkdirResult;
				if (serverInfo.os === 1) {
					mkdirResult = await execRemote({
						username: uName,
						password: uPwd,
						server: serverAddress,
						command: `powershell -Command "New-Item -ItemType Directory -Force -Path '${backupBase}' | Out-Null; Get-ChildItem -LiteralPath '${backupBase}' -Force | Remove-Item -Recurse -Force"`,
					});
				} else if (serverInfo.os === 2) {
					mkdirResult = await execRemote({
						username: uName,
						password: uPwd,
						server: serverAddress,
						command: `mkdir -p '${backupBase}' && find '${backupBase}' -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
					});
				} else {
					printInfoLog(`未找到 ${displayOs(Number(serverInfo.os))} 部署环境，请检查.`, "log-error");
					return false;
				}
				if (mkdirResult.code !== 0) {
					printInfoLog(`准备备份文件夹 ${backupBase} 失败：${mkdirResult.data}`, "log-error");
					return false;
				}
				printInfoLog(`备份文件夹 ${backupBase} 已就绪（内容已清空），耗时 ${formatElapsed(Date.now() - mkdirStartTime)}.`);

				// 逐个服务整体拷贝进日期文件夹（备份文件夹名默认=目录名，重名时逐级拼接上级目录）
				printInfoLog(
					`步骤 2/3：逐个备份服务到 ${backupBase}（共 ${serverInstances.length} 个，整目录拷贝）...`
				);
				const backupFolderNames = computeBackupFolderNames(serverInstances);
				for (let i = 0; i < serverInstances.length; i++) {
					if (checkStop()) return false;
					const ins = serverInstances[i];
					const backupFolderName = backupFolderNames[i];
					const backupTarget = `${backupBase}/${backupFolderName}`;
					printInfoLog(`[${i + 1}/${serverInstances.length}] 正在备份 ${ins.module}：${removeSlash(ins.path)} → ${backupTarget}`);
					const copyStartTime = Date.now();
					let copyResult;
					if (serverInfo.os === 1) {
						copyResult = await execRemote({
							username: uName,
							password: uPwd,
							server: serverAddress,
							command: `powershell -Command "Copy-Item -Path '${removeSlash(ins.path)}' -Destination '${backupTarget}' -Recurse -Force"`,
						});
					} else {
						copyResult = await execRemote({
							username: uName,
							password: uPwd,
							server: serverAddress,
							command: `cp -a '${removeSlash(ins.path)}' '${backupTarget}'`,
						});
					}
					if (copyResult.code !== 0) {
						printInfoLog(`备份 ${ins.module} 失败（${removeSlash(ins.path)} → ${backupTarget}）：${copyResult.data}`, "log-error");
						return false;
					}
					printInfoLog(
						`[${i + 1}/${serverInstances.length}] 备份 ${ins.module} 完成（${backupFolderName}），耗时 ${formatElapsed(Date.now() - copyStartTime)}.`,
						"log-success"
					);
				}

				// 更新备份文件夹的修改时间为当前时间，便于按时间识别最近一次备份
			// （同一日期重复备份时覆盖文件不会刷新文件夹的修改时间）
			printInfoLog(`步骤 3/3：更新备份文件夹 ${backupBase} 的修改时间为当前时间（便于查看备份时间）...`);
			const touchStartTime = Date.now();
			let touchResult;
			if (serverInfo.os === 1) {
				touchResult = await execRemote({
					username: uName,
					password: uPwd,
					server: serverAddress,
					command: `powershell -Command "(Get-Item -LiteralPath '${backupBase}').LastWriteTime = Get-Date"`,
				});
			} else {
				touchResult = await execRemote({
					username: uName,
					password: uPwd,
					server: serverAddress,
					command: `touch '${backupBase}'`,
				});
			}
			if (touchResult.code !== 0) {
				printInfoLog(`更新备份文件夹 ${backupBase} 的修改时间失败：${touchResult.data}`, "log-error");
				return false;
			}
			printInfoLog(`备份文件夹 ${backupBase} 的修改时间已更新为当前时间，耗时 ${formatElapsed(Date.now() - touchStartTime)}.`);

			// 写入服务器备份日志：<服务备份路径>/备份日志.log，记录备份时间文件夹及其内一级目录（各服务文件夹）
			const backupLogFolderNames = computeBackupFolderNames(serverInstances);
			await appendRemoteLogLine({
				isWindows: Number(serverInfo.os) === 1,
				username: uName,
				password: uPwd,
				server: serverAddress,
				logPath: `${removeSlash(String(serverInfo.serviceBackupPath))}/备份日志.log`,
				line: `备份 ${dateFolderName}：${backupLogFolderNames.join("、")}`,
			});

				printInfoLog(
					`服务器[${serverInfo.name}]备份完成，总耗时 ${formatElapsed(Date.now() - serverStartTime)}.`,
					"log-success"
				);
				return true;
			})();
			if (!backupSuccess) {
				isSuccess = false;
				break;
			}
		}
		// 已手动停止时不打印总耗时，避免停止后出现后续提示
		if (!checkStop()) {
			printInfoLog(`备份服务总耗时：${formatElapsed(Date.now() - overallStartTime)}。`);
		}
		return isSuccess;
	};

	// ==================== 打包wpf ====================

	/**
	 * 打包wpf：根据配置，获取服务器上的配置文件(Manifest.xml)、压缩包后更新并打包（只打包到本地，不上传）
	 * 产出目录：程序集输出路径/WpfClient/packOutput/<服务器id>/（按服务器区分，多服务器互不覆盖）
	 */
	const packWpfClient = async () => {
		resetStopState();
		const ci = ctx.appconfigData().configItems;
		const wpfClientItem = ci?.wpfClient;
		if (!wpfClientItem?.clientPath) {
			printInfoLog(`应用配置中未配置 ${MODULE_NAMES.wpfClient} 的[客户端生成路径]，请检查.`, "log-error");
			return false;
		}
		printInfoLog("");

		// 获取[生成目录]
		if (!wpfClientItem.generateDirJson) {
			printInfoLog(`服务[${MODULE_NAMES.wpfClient}]未配置[生成目录]，请检查.`, "log-error");
			return false;
		}
		const generateDirs = JSON.parse(wpfClientItem.generateDirJson) as string[];

		// 存量兼容：旧单服务器配置归一化为多服务器结构
		if ((!wpfClientItem.serverArr || wpfClientItem.serverArr.length < 1) && wpfClientItem.serverId) {
			wpfClientItem.serverIds = [wpfClientItem.serverId];
			wpfClientItem.serverArr = [
				{
					id: wpfClientItem.serverId,
					name: wpfClientItem.serverName,
					serverPathArr: [
						{
							label: "",
							value: [{ identity: "", path: wpfClientItem.serverPath || "" }],
						},
					],
				},
			];
		}
		const wpfServerArr = wpfClientItem.serverArr || [];
		if (wpfServerArr.length < 1) {
			printInfoLog(` ${MODULE_NAMES.wpfClient} 未选择服务或该服务器不存在，请检查.`, "log-error");
			return false;
		}

		const isNewVersion = Boolean(ctx.appconfigData().configItems.isNewVersion);
		const wpfClientPath = removeSlash(String(wpfClientItem.clientPath));
		let isSuccess = true;

		printInfoLog(`打包方式：${isNewVersion ? "新版本结构" : "旧版结构"}，只打包到本地不上传`);
		printInfoLog(`版本结构（生成目录）：${generateDirs.join("、")}`);
		printInfoLog(`源路径（客户端生成路径）：${wpfClientPath}`);
		printInfoLog(`参与服务器：${wpfServerArr.length} 台（${wpfServerArr.map((s) => s.name).join("、")}）`);
		const overallStartTime = Date.now();

		for (let srvIdx = 0; srvIdx < wpfServerArr.length; srvIdx++) {
			if (checkStop()) return false;
			const wpfServer = wpfServerArr[srvIdx];
			const packSuccess = await (async () => {
				if (!wpfServer.id) {
					printInfoLog(` ${MODULE_NAMES.wpfClient} 未选择服务或该服务器不存在，请检查.`, "log-error");
					return false;
				}
				const serverInfo = await getServerDetail(Number(wpfServer.id));
				if (!serverInfo) {
					printInfoLog(`服务[${MODULE_NAMES.wpfClient}]不存在，请检查.`, "log-error");
					return false;
				}
				const serverPath = wpfServer.serverPathArr?.[0]?.value?.[0]?.path;
				if (!serverPath) {
					printInfoLog(`服务[${MODULE_NAMES.wpfClient}]未填写服务发布路径，请检查.`, "log-error");
					return false;
				}
				const uName = serverInfo.account;
				const uPwd = serverInfo.pwd;
				const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;

				printInfoLog(`打包 ${MODULE_NAMES.wpfClient} 服务[${wpfServer.name}]中，请稍等！`);
				printInfoLog(`服务器：${wpfServer.name}（${displayOs(Number(serverInfo.os))} ${serverAddress}）`);
				const serverStartTime = Date.now();

				// 本地打包输出目录（按服务器 id 区分：packOutput/<服务器id>，多服务器互不覆盖）
				const packDir = `${ctx.assemblyOutPath()}/${MODULE_NAMES.wpfClient}/packOutput/${Number(wpfServer.id)}`;
				printInfoLog(`步骤 1/4：准备本地打包目录：${packDir}`);
				const prepStartTime = Date.now();
				const packDirExists = await cmdInvoke("exists", { path: packDir });
				if (packDirExists.code === 0) {
					await cmdInvoke("delete_paths", { paths: [packDir] });
					printInfoLog(`已清理旧打包目录.`);
				}
				let createPackDirResult = await createDir(packDir);
				if (!createPackDirResult) {
					printInfoLog(`创建本地打包目录失败：${packDir}`, "log-error");
					return false;
				}
				printInfoLog(`本地打包目录就绪，耗时 ${formatElapsed(Date.now() - prepStartTime)}.`);

				// 组装远程文件清单
				let remoteFiles = [`${removeSlash(serverPath)}/Manifest.xml`];
				if (isNewVersion) {
					for (let i = 0; i < generateDirs.length; i++) {
						remoteFiles.push(`${removeSlash(serverPath)}/${generateDirs[i]}.zip`);
					}
				} else {
					if (generateDirs.includes("Domain") || generateDirs.includes("UI")) {
						remoteFiles.push(`${removeSlash(serverPath)}/Plugins.zip`);
					}
					for (let i = 0; i < generateDirs.length; i++) {
						const generateDir = generateDirs[i];
						if (generateDir == "Domain" || generateDir == "UI") continue;
						remoteFiles.push(`${removeSlash(serverPath)}/${generateDir}.zip`);
					}
				}

			let localFiles = new Array<string>();
			for (let i = 0; i < remoteFiles.length; i++) {
				const remoteFile = remoteFiles[i];
				const remoteFileName = remoteFile.substring(remoteFile.lastIndexOf("/") + 1);
				localFiles.push(`${packDir}/${remoteFileName}`);
			}
			printInfoLog(`步骤 2/4：下载远程服务文件（共 ${remoteFiles.length} 个）...`);
			printInfoLog(`下载清单：${remoteFiles.join("  ;  ")}`);
			const downloadStartTime = Date.now();
			// 逐文件下载：每完成一个刷新计数，单文件下载期间由后端进度事件刷新字节百分比
			const downloadLogIndex = printInfoLog(`正在下载远程服务文件...`);
			updateLogProgress(downloadLogIndex, "已下载 ", 0, remoteFiles.length);
			for (let i = 0; i < remoteFiles.length; i++) {
				if (checkStop()) return false;
				const remoteFileName = remoteFiles[i].substring(remoteFiles[i].lastIndexOf("/") + 1);
				setProgressTarget(downloadLogIndex, `已下载 ${i}/${remoteFiles.length} 个文件`);
				const downloadServerFileResult = await cmdInvoke("download_server_files", {
					username: uName,
					password: uPwd,
					server: serverAddress,
					remotePaths: [remoteFiles[i]],
					localPaths: [localFiles[i]],
				});
				if (downloadServerFileResult.code !== 0) {
					clearProgressTarget();
					printInfoLog(`下载 ${remoteFileName} 失败：[${downloadServerFileResult.data}].`, "log-error");
					return false;
				}
				updateLogProgress(downloadLogIndex, "已下载 ", i + 1, remoteFiles.length);
				printInfoLog(`已下载 ${remoteFileName}.`, "log-success");
			}
			clearProgressTarget();
			setLogProgressText(downloadLogIndex, "");
			printInfoLog(`下载远程服务文件完成，耗时 ${formatElapsed(Date.now() - downloadStartTime)}.`, "log-success");

			const manifestLocalFile = `${removeSlash(packDir)}/Manifest.xml`;

			// 处理下载的 zip：解压 → 合并本地生成目录 → 重新打包 → 更新版本号
			const zipCount = localFiles.filter((f) => f.endsWith(".zip")).length;
			printInfoLog(
				`步骤 3/4：处理压缩包（解压 → 合并本地生成目录 → 重新打包 → 更新 Manifest.xml 版本号，共 ${zipCount} 个）...`
			);
			for (let i = 0; i < localFiles.length; i++) {
				if (checkStop()) return false;
				const localFile = localFiles[i];
				const lastIndex = localFile.lastIndexOf("/");
				const fileName = `${localFile.substring(lastIndex + 1)}`;
				if (!fileName.endsWith(".zip")) continue;
				const dirName = fileName.replace(".zip", "");
				const zipStartTime = Date.now();

					// 解压
					let unzipPath = removeSlash(`${localFile.substring(0, lastIndex + 1)}`);
					if (isNewVersion && (fileName == "Plugins.zip" || fileName == "Lib.zip")) {
						unzipPath = `${unzipPath}/${dirName}`;
					}
					printInfoLog(`正在解压 ${fileName} 到 ${unzipPath}.`);
					const unzipResult = await cmdInvoke("un_zip", {
						filePaths: [localFile],
						destination: unzipPath,
					});
					if (unzipResult.code !== 0) {
						printInfoLog(`解压 ${fileName} 到 ${unzipPath} 失败：${unzipResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`解压 ${fileName} 成功.`, "log-success");

				// 将生成的文件复制到[打包目录]
				const mergeStartTime = Date.now();
				if (isNewVersion) {
						const sourcePath = `${wpfClientPath}/${dirName}`;
						const destinationPath = `${removeSlash(packDir)}/${dirName}`;
						const copyResult = await cmdInvoke("copy_path", {
							source: sourcePath,
							destination: destinationPath,
							...getRetryArgs("copy"),
						});
						if (copyResult.code !== 0) {
							printInfoLog(`合并本地生成目录失败：复制 ${sourcePath} → ${destinationPath} 失败：${copyResult.data}.`, "log-error");
							return false;
						}
					} else if (dirName == "Plugins") {
						// Domain
						const sourceDomainPath = `${wpfClientPath}/Domain`;
						const destinationDomainPath = `${removeSlash(packDir)}/Domain`;
						const copyDomainResult = await cmdInvoke("copy_path", {
							source: sourceDomainPath,
							destination: destinationDomainPath,
							...getRetryArgs("copy"),
						});
						if (copyDomainResult.code !== 0) {
							printInfoLog(`合并本地生成目录失败：复制 ${sourceDomainPath} → ${destinationDomainPath} 失败：${copyDomainResult.data}.`, "log-error");
							return false;
						}
						// UI
						const sourceUiPath = `${wpfClientPath}/UI`;
						const destinationUiPath = `${removeSlash(packDir)}/UI`;
						const copyUiResult = await cmdInvoke("copy_path", {
							source: sourceUiPath,
							destination: destinationUiPath,
							...getRetryArgs("copy"),
						});
						if (copyUiResult.code !== 0) {
							printInfoLog(`合并本地生成目录失败：复制 ${sourceUiPath} → ${destinationUiPath} 失败：${copyUiResult.data}.`, "log-error");
							return false;
						}
					} else {
						const sourcePath = `${wpfClientPath}/${dirName}`;
						const destinationPath = `${removeSlash(packDir)}/${dirName}`;
						const copyResult = await cmdInvoke("copy_path", {
							source: sourcePath,
							destination: destinationPath,
							...getRetryArgs("copy"),
						});
						if (copyResult.code !== 0) {
							printInfoLog(`合并本地生成目录失败：复制 ${sourcePath} → ${destinationPath} 失败：${copyResult.data}.`, "log-error");
							return false;
						}
					}

				// 重新打包压缩（压缩过程由后端进度事件刷新文件数进度）
				const compressLogIndex = printInfoLog(`正在压缩 ${dirName}.zip ...`);
				let compresseResult: any;
				setProgressTarget(compressLogIndex, "");
				try {
					if (dirName == "Plugins" || dirName == "Lib") {
						compresseResult = await cmdInvoke("zip_dir", {
							srcDir: `${removeSlash(packDir)}/${dirName}`,
							dstFile: `${removeSlash(packDir)}/${dirName}.zip`,
						});
					} else {
						compresseResult = await cmdInvoke("compress_zip", {
							filePaths: [`${removeSlash(packDir)}/${dirName}`],
							dstFile: `${removeSlash(packDir)}/${dirName}.zip`,
						});
					}
				} finally {
					clearProgressTarget();
					setLogProgressText(compressLogIndex, "");
				}
				if (compresseResult.code !== 0) {
					printInfoLog(`压缩[${dirName}.zip]失败：${compresseResult.data}.`, "log-error");
					return false;
				}
				printInfoLog(
					`已合并本地生成目录并重新打包 ${dirName}.zip（${dirName == "Plugins" || dirName == "Lib" ? "整目录压缩" : "压缩目录本身"}），耗时 ${formatElapsed(Date.now() - mergeStartTime)}.`,
					"log-success"
				);

					// 升级版本号
					printInfoLog(`正在更新清单文件 Manifest.xml 中 ${dirName} 模块的版本号（版本号自动+1，文件：${manifestLocalFile}）.`);
					const upgradeVersionResult = await cmdInvoke("upgrade_module_version", {
						filePath: manifestLocalFile,
						moduleName: dirName,
					});
					if (upgradeVersionResult.code !== 0) {
						printInfoLog(`更新 Manifest.xml 中 ${dirName} 模块的版本号失败：${upgradeVersionResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`已将 Manifest.xml 中 ${dirName} 模块的版本号更新为 ${upgradeVersionResult.data}.`, "log-success");

				// 清理解压的中间目录，仅保留 zip 与 Manifest.xml
				const unzippedDir = `${removeSlash(packDir)}/${dirName}`;
				const unzippedDirExists = await cmdInvoke("exists", { path: unzippedDir });
				if (unzippedDirExists.code === 0) {
					await cmdInvoke("delete_paths", { paths: [unzippedDir] });
				}
				printInfoLog(
					`[${dirName}.zip] 处理完成，总耗时 ${formatElapsed(Date.now() - zipStartTime)}.`
				);
			}

			printInfoLog(`步骤 4/4：打包完成，产出目录：${packDir}`);
			printInfoLog(
				`服务器[${wpfServer.name}]打包完成，总耗时 ${formatElapsed(Date.now() - serverStartTime)}.`,
				"log-success"
			);
			return true;
		})();
		if (!packSuccess) {
			isSuccess = false;
			break;
		}
	}
	if (isSuccess) {
		printInfoLog(`打包wpf总耗时：${formatElapsed(Date.now() - overallStartTime)}。`);
	}
		return isSuccess;
	};

	// ==================== 上传程序集 ====================

	/**
	 * 逐文件上传（文件计数 + 字节进度）
	 * @returns 空串=成功；非空=错误信息
	 */
	const uploadAssemblyFiles = async (params: {
		localDir: string;
		remoteDir: string;
		files: string[];
		username: string;
		password: string;
		server: string;
	}): Promise<string> => {
		const currLogIndex = printInfoLog(`正在上传 ${params.files.length} 个文件到 ${params.remoteDir}...`);
		updateLogProgress(currLogIndex, "已上传 ", 0, params.files.length);
		for (let l = 0; l < params.files.length; l++) {
			if (checkStop()) return "已手动停止";
			const projectFile = params.files[l];
			setProgressTarget(currLogIndex, `已上传 ${l}/${params.files.length} 个文件`);
			let uploadResult: any;
			try {
				uploadResult = await uploadServerFilesWithRetry({
					localPaths: [`${params.localDir}/${projectFile}`],
					remotePaths: [`${params.remoteDir}/${projectFile}`],
					username: params.username,
					password: params.password,
					server: params.server,
				});
			} finally {
				clearProgressTarget();
				setLogProgressText(currLogIndex, "");
			}
			if (uploadResult.code !== 0) {
				printInfoLog(`上传 ${projectFile} → ${params.remoteDir}/${projectFile} 失败：${uploadResult.data}.`, "log-error");
				return String(uploadResult.data ?? "上传失败");
			}
			updateLogProgress(currLogIndex, "已上传 ", l + 1, params.files.length);
		}
		return "";
	};

	/**
	 * 探测服务器是否具备解压能力（Linux: unzip；Windows: PowerShell Expand-Archive）
	 * 用「必定 exit 0 + 输出标记」的方式探测：命令不存在时不会触发后端重试，也不会产生重试日志
	 * @returns true=可用（可以走打包上传）
	 */
	const checkRemoteUnzipAvailable = async (params: {
		isWindows: boolean;
		username: string;
		password: string;
		server: string;
	}): Promise<boolean> => {
		const command = params.isWindows
			? `powershell -NoProfile -Command "if (Get-Command Expand-Archive -ErrorAction SilentlyContinue) { Write-Output 'UNZIP_OK' } else { Write-Output 'UNZIP_MISSING' }"`
			: `command -v unzip >/dev/null 2>&1 && echo UNZIP_OK || echo UNZIP_MISSING`;
		const probeResult = await execRemote({
			username: params.username,
			password: params.password,
			server: params.server,
			command,
			retryCount: 1,
		});
		if (probeResult.code !== 0) {
			return false;
		}
		return String(probeResult.data ?? "").includes("UNZIP_OK");
	};

	/**
	 * 将本批次所有模块的程序集目录打包为同一个 zip（各模块在包内落成 <模块名>/ 顶层目录）
	 * 上传后在服务端一次性解压：N 个模块只需 1 次上传 / 1 次解压
	 * @param sources 打包源（srcDir 本地目录，entry 包内顶层目录名）
	 * @returns zip 路径；空串=打包失败
	 */
	const packBatchZip = async (sources: { srcDir: string; entry: string }[]): Promise<string> => {
		const zipPath = `${removeSlash(String(ctx.assemblyOutPath()))}/${BATCH_ZIP_NAME}`;
		const zipExists = await cmdInvoke("exists", { path: zipPath });
		if (zipExists.code === 0) {
			await cmdInvoke("delete_paths", { paths: [zipPath] });
		}
		printInfoLog(
			`准备上传：${sources.map((s) => s.entry).join("、")} 合并打包为 ${BATCH_ZIP_NAME}（上传后在服务端一次性解压）...`
		);
		const packStartTime = Date.now();
		const packLogIndex = printInfoLog(`正在打包 ${BATCH_ZIP_NAME} ...`);
		let packResult: any;
		setProgressTarget(packLogIndex, "");
		try {
			packResult = await cmdInvoke("zip_dirs", { sources, dstFile: zipPath });
		} finally {
			clearProgressTarget();
			setLogProgressText(packLogIndex, "");
		}
		if (packResult.code !== 0) {
			printInfoLog(`打包 ${BATCH_ZIP_NAME} 失败：${packResult.data}.`, "log-error");
			return "";
		}
		printInfoLog(
			`已打包 ${BATCH_ZIP_NAME}（${sources.length} 个模块），耗时 ${formatElapsed(Date.now() - packStartTime)}.`,
			"log-success"
		);
		return zipPath;
	};

	/**
	 * 整包上传：上传单个 zip 到服务器后一次性解压到暂存目录根（模块目录由包内顶层目录还原）
	 * @returns 空串=成功；非空=错误信息（调用方据此回退逐文件上传）
	 */
	const uploadBatchZip = async (params: {
		localZipPath: string;
		remoteZipPath: string;
		remoteDir: string;
		isWindows: boolean;
		username: string;
		password: string;
		server: string;
	}): Promise<string> => {
		const zipName = params.localZipPath.substring(params.localZipPath.lastIndexOf("/") + 1);

		// 上传整包
		const uploadLogIndex = printInfoLog(`正在上传 ${zipName} ...`);
		const zipUploadStartTime = Date.now();
		let uploadResult: any;
		setProgressTarget(uploadLogIndex, "");
		try {
			uploadResult = await uploadServerFilesWithRetry({
				localPaths: [params.localZipPath],
				remotePaths: [params.remoteZipPath],
				username: params.username,
				password: params.password,
				server: params.server,
			});
		} finally {
			clearProgressTarget();
			setLogProgressText(uploadLogIndex, "");
		}
		if (uploadResult.code !== 0) {
			printInfoLog(`上传 ${zipName} 失败：${uploadResult.data}.`, "log-error");
			return String(uploadResult.data ?? "上传失败");
		}
		printInfoLog(`已上传 ${zipName}，耗时 ${formatElapsed(Date.now() - zipUploadStartTime)}.`, "log-success");

		// 服务端解压（Windows 用 PowerShell Expand-Archive，旧版 tar/bsdtar 不支持 zip；Linux 用 unzip）
		const unzipStartTime = Date.now();
		const unzipCommand = params.isWindows
			? buildPowerShellEncodedCommand(
					`Expand-Archive -Path '${escapePowerShellLiteral(params.remoteZipPath.replace(/\//g, "\\"))}' -DestinationPath '${escapePowerShellLiteral(
						params.remoteDir.replace(/\//g, "\\")
					)}' -Force`
				)
			: `unzip -o '${escapePosixLiteral(params.remoteZipPath)}' -d '${escapePosixLiteral(params.remoteDir)}'`;
		printInfoLog(`正在服务端解压 ${zipName} 到 ${params.remoteDir} ...`);
		const unzipResult = await execRemote({
			username: params.username,
			password: params.password,
			server: params.server,
			command: unzipCommand,
		});
		if (unzipResult.code !== 0) {
			printInfoLog(`服务端解压 ${zipName} 失败：${unzipResult.data}.`, "log-error");
			return String(unzipResult.data ?? "解压失败");
		}
		printInfoLog(`服务端解压完成，耗时 ${formatElapsed(Date.now() - unzipStartTime)}.`, "log-success");

		// 清理服务端临时 zip（避免污染程序集暂存目录）
		const deleteCommand = params.isWindows
			? buildPowerShellEncodedCommand(
					`Remove-Item -LiteralPath '${escapePowerShellLiteral(params.remoteZipPath.replace(/\//g, "\\"))}' -Force`
				)
			: `rm -f '${escapePosixLiteral(params.remoteZipPath)}'`;
		const deleteResult = await execRemote({
			username: params.username,
			password: params.password,
			server: params.server,
			command: deleteCommand,
		});
		if (deleteResult.code !== 0) {
			printInfoLog(`清理服务端临时文件 ${zipName} 失败：${deleteResult.data}（不影响上传结果）.`, "log-warning");
		}
		return "";
	};

	/**
	 * 清空服务器上本批次涉及的所有模块暂存目录（先删目录再重建，隐藏文件、多层子目录一并清掉）
	 * 一条远程命令处理全部模块，避免逐模块往返；供【发布】覆盖前保证暂存目录无历史残留
	 * @returns ok=false 时 message 为失败原因；cleared 为清掉的条目总数（解析不到为 null）
	 */
	const clearRemoteModuleDirs = async (params: {
		stagingRoot: string;
		moduleNames: string[];
		isWindows: boolean;
		username: string;
		password: string;
		server: string;
	}): Promise<{ ok: boolean; message: string; cleared: number | null }> => {
		let command: string;
		if (params.isWindows) {
			const moduleList = params.moduleNames.map((m) => `'${escapePowerShellLiteral(m)}'`).join(", ");
			const script = [
				"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
				`$base = '${escapePowerShellLiteral(params.stagingRoot)}'`,
				`$modules = @(${moduleList})`,
				"$n = 0",
				"foreach ($m in $modules) {",
				"  $p = Join-Path $base $m",
				"  if (Test-Path -LiteralPath $p) {",
				"    $n += (Get-ChildItem -LiteralPath $p -Force | Measure-Object).Count",
				"    try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop } catch { Write-Output ('CLEAR_FAILED ' + $_.Exception.Message); exit 1 }",
				"  }",
				"  New-Item -ItemType Directory -Force -Path $p | Out-Null",
				"}",
				"Write-Output ('CLEARED ' + $n)",
			].join("\r\n");
			command = buildPowerShellEncodedCommand(script);
		} else {
			const dirs = params.moduleNames
				.map((m) => `'${escapePosixLiteral(`${params.stagingRoot}/${m}`)}'`)
				.join(" ");
			command =
				`n=0; for p in ${dirs}; do` +
				` if [ -d "$p" ]; then n=$((n + $(find "$p" -mindepth 1 -maxdepth 1 | wc -l))); fi;` +
				` rm -rf "$p" || { echo 'CLEAR_FAILED rm'; exit 1; };` +
				` mkdir -p "$p" || { echo 'CLEAR_FAILED mkdir'; exit 1; };` +
				` done; echo "CLEARED $n"`;
		}
		const result = await execRemote({
			username: params.username,
			password: params.password,
			server: params.server,
			command,
		});
		if (result.code !== 0) {
			return { ok: false, message: String(result.data ?? "清空失败"), cleared: null };
		}
		// 条目数为日志增强信息，解析不到时降级为不含数量的文案
		const clearedMatch = String(result.data ?? "").match(/CLEARED\s+(\d+)/);
		return { ok: true, message: "", cleared: clearedMatch ? Number(clearedMatch[1]) : null };
	};

	/**
	 * 上传程序集：把本次要发布的所有模块目录合并为一个压缩包，按服务器一次上传、一次解压
	 * 目录约定：<暂存路径>/<模块名>/（服务端解压后与逐文件上传的结果完全一致）
	 * 服务器无解压能力或整包上传失败时，回退为逐模块逐文件上传
	 */
	const uploadAssemblies = async () => {
		resetStopState();
		const modules = getStepModules();
		if (modules.length < 1) {
			printInfoLog("应用配置中未找到任何模块，请先获取程序集或检查应用配置.", "log-error");
			return false;
		}
		printInfoLog("");

		// 按服务器聚合：同一台服务器上的多个模块合并进同一个压缩包，只上传一次
		const groups: { serverId: number; serverName: string; modules: { module: StepModule }[] }[] = [];
		const groupIndexOf = new Map<number, number>();
		for (const module of modules) {
			for (const server of module.serverArr) {
				if (!server.id) {
					printInfoLog(` ${module.name} 未选择服务或该服务器不存在，请检查.`, "log-error");
					return false;
				}
				const serverId = Number(server.id);
				const existingIndex = groupIndexOf.get(serverId);
				if (existingIndex === undefined) {
					groupIndexOf.set(serverId, groups.length);
					groups.push({ serverId, serverName: String(server.name ?? ""), modules: [{ module }] });
				} else {
					groups[existingIndex].modules.push({ module });
				}
			}
		}
		if (groups.length < 1) {
			printInfoLog("应用配置中未找到任何服务器的上传目标，请检查服务配置.", "log-error");
			return false;
		}

		// 入口信息
		printInfoLog(`上传方式：本地程序集合并打包 → 服务器程序集暂存路径（<暂存路径>/<模块名>）`);
		printInfoLog(
			`参与模块：${modules.length} 个（${modules.map((m) => m.name).join("、")}），共 ${groups.length} 台服务器（每台 1 次上传 / 1 次解压）`
		);
		const overallStartTime = Date.now();

		let isSuccess = true;
		// 服务器解压能力探测结果缓存：同一服务器只探测一次（key = 服务器地址|系统）
		const unzipSupportCache: Record<string, boolean> = {};
		// 整包缓存：key = 打包源签名（模块组合 + 本地目录），同一组合多服务器只压缩一次
		let batchZip = { key: "", path: "" };
		const cleanupBatchZip = async () => {
			if (batchZip.path) {
				await cmdInvoke("delete_paths", { paths: [batchZip.path] });
				batchZip = { key: "", path: "" };
			}
		};

		try {
			for (const group of groups) {
				if (checkStop()) {
					isSuccess = false;
					break;
				}
				const serverInfo = await getServerDetail(group.serverId);
				if (!serverInfo) {
					printInfoLog(`服务[${group.serverName}]不存在，请检查.`, "log-error");
					isSuccess = false;
					break;
				}
				if (!serverInfo.assemblyStagingPath) {
					printInfoLog(`服务器[${serverInfo.name}]未配置[程序集暂存路径]，请先在服务器管理中配置.`, "log-error");
					isSuccess = false;
					break;
				}

				const moduleNames = group.modules.map((m) => m.module.name);
				const tabStartTime = Date.now();
				const uploadSuccess = await (async () => {
					const uName = serverInfo.account;
					const uPwd = serverInfo.pwd;
					const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;
					const stagingRoot = removeSlash(String(serverInfo.assemblyStagingPath));
					const isWindows = Number(serverInfo.os) === 1;
					printInfoLog(`服务器：${serverInfo.name}（${displayOs(Number(serverInfo.os))} ${serverAddress}）`);
					printInfoLog(`上传目标：${stagingRoot}/<${moduleNames.join("|")}>`);
					printInfoLog(`参与模块：${moduleNames.join("、")}（合并为 1 个压缩包）`);

					// 步骤 1/6：逐个模块校验本地目录并统计文件
					printInfoLog(`步骤 1/6：校验本地目录（${moduleNames.length} 个模块）...`);
					const prepared: { module: StepModule; localDir: string; files: string[] }[] = [];
					for (const target of group.modules) {
						if (checkStop()) return false;
						// WpfClient 从打包产出目录（packOutput/<服务器id>）上传；其余模块从程序集输出目录上传
						const localDir =
							target.module.name === MODULE_NAMES.wpfClient
								? `${removeSlash(String(ctx.assemblyOutPath()))}/${MODULE_NAMES.wpfClient}/packOutput/${group.serverId}`
								: `${removeSlash(String(ctx.assemblyOutPath()))}/${target.module.name}`;
						const localDirExists = await cmdInvoke("exists", { path: localDir });
						if (localDirExists.code !== 0) {
							printInfoLog(
								target.module.name === MODULE_NAMES.wpfClient
									? `未找到本地打包目录：${localDir}，请先执行【打包wpf】.`
									: `未找到本地程序集目录：${localDir}，请先执行【获取程序集】.`,
								"log-error"
							);
							return false;
						}
						const files = await readDirFiles(localDir);
						if (files.length < 1) {
							printInfoLog(`本地目录为空：${localDir}`, "log-warning");
							return false;
						}
						printInfoLog(
							`${target.module.name}：${files.length} 个文件（${files.slice(0, 5).join("、")}${files.length > 5 ? " 等" : ""}），来源 ${localDir}`
						);
						prepared.push({ module: target.module, localDir, files });
					}

					// 步骤 2/6：在服务器上创建暂存目录根（模块目录由步骤 5 清空时一并重建）
					printInfoLog(`步骤 2/6：准备服务器暂存目录（不存在则创建）...`);
					const mkdirStartTime = Date.now();
					const mkdirCommand = isWindows
						? buildPowerShellEncodedCommand(
								`New-Item -ItemType Directory -Force -Path '${escapePowerShellLiteral(stagingRoot)}' | Out-Null`
							)
						: `mkdir -p '${escapePosixLiteral(stagingRoot)}'`;
					const mkdirResult = await execRemote({
						username: uName,
						password: uPwd,
						server: serverAddress,
						command: mkdirCommand,
					});
					if (mkdirResult.code !== 0) {
						printInfoLog(`创建暂存目录失败：${mkdirResult.data}`, "log-error");
						return false;
					}
					printInfoLog(`暂存目录就绪，耗时 ${formatElapsed(Date.now() - mkdirStartTime)}.`);

					// 步骤 3/6：探测服务端解压命令（同一服务器一次运行只探测一次）
					printInfoLog(`步骤 3/6：探测服务器解压命令...`);
					const unzipCmdName = isWindows ? "PowerShell Expand-Archive" : "unzip";
					const unzipCacheKey = `${serverAddress}|${isWindows ? "win" : "linux"}`;
					if (unzipSupportCache[unzipCacheKey] === undefined) {
						printInfoLog(`检查服务器解压命令（${unzipCmdName}）是否可用...`);
						unzipSupportCache[unzipCacheKey] = await checkRemoteUnzipAvailable({
							isWindows,
							username: uName,
							password: uPwd,
							server: serverAddress,
						});
					}
					const canUnzip = unzipSupportCache[unzipCacheKey];
					if (!canUnzip) {
						printInfoLog(
							`服务器[${serverInfo.name}]无可用解压命令（${unzipCmdName}），回退为逐文件上传.`,
							"log-warning"
						);
					}

					// 步骤 4/6：本地整包打包（同一模块组合多服务器只压缩一次）
					let zipUploadPath = "";
					if (canUnzip) {
						printInfoLog(`步骤 4/6：本地打包（${moduleNames.length} 个模块 → 1 个压缩包）...`);
						const sources = prepared.map((item) => ({ srcDir: item.localDir, entry: item.module.name }));
						const zipKey = sources
							.map((s) => `${s.entry}|${s.srcDir}`)
							.sort()
							.join(";");
						if (batchZip.path && batchZip.key === zipKey) {
							zipUploadPath = batchZip.path;
							printInfoLog(`复用已打包的 ${BATCH_ZIP_NAME}（模块组合与本地来源一致）`, "log-success");
						} else {
							await cleanupBatchZip();
							const packedPath = await packBatchZip(sources);
							if (!packedPath) return false;
							batchZip = { key: zipKey, path: packedPath };
							zipUploadPath = packedPath;
						}
					} else {
						printInfoLog(`步骤 4/6：跳过本地打包（服务器无解压能力，改为逐文件上传）...`);
					}
					if (checkStop()) return false;

					// 步骤 5/6：清空全部模块暂存目录（一条命令处理，避免逐模块往返）
					printInfoLog(`步骤 5/6：清空服务器暂存目录的原有文件（防止旧文件被发布到服务内）...`);
					const clearStartTime = Date.now();
					const clearResult = await clearRemoteModuleDirs({
						stagingRoot,
						moduleNames,
						isWindows,
						username: uName,
						password: uPwd,
						server: serverAddress,
					});
					if (!clearResult.ok) {
						printInfoLog(
							`清空服务器暂存目录 ${stagingRoot} 失败：${clearResult.message}（为避免残留旧文件，已中止本次上传）`,
							"log-error"
						);
						return false;
					}
					printInfoLog(
						clearResult.cleared === null
							? `暂存目录已清空并重建（${moduleNames.length} 个模块），耗时 ${formatElapsed(Date.now() - clearStartTime)}.`
							: `暂存目录已清空并重建（${moduleNames.length} 个模块，原有 ${clearResult.cleared} 个条目），耗时 ${formatElapsed(
									Date.now() - clearStartTime
								)}.`,
						"log-success"
					);

					// 步骤 6/6：一次上传整包 → 一次解压
					printInfoLog(`步骤 6/6：上传整包并在服务端解压（1 次上传 / 1 次解压）...`);
					const uploadStartTime = Date.now();
					let uploadError = "";
					if (zipUploadPath) {
						printInfoLog(`采用整包上传：${BATCH_ZIP_NAME} → 服务端解压到 ${stagingRoot} ...`);
						uploadError = await uploadBatchZip({
							localZipPath: zipUploadPath,
							remoteZipPath: `${stagingRoot}/${BATCH_ZIP_NAME}`,
							remoteDir: stagingRoot,
							isWindows,
							username: uName,
							password: uPwd,
							server: serverAddress,
						});
						if (uploadError) {
							// 手动停止不打印回退提示，直接结束
							if (checkStop()) return false;
							printInfoLog(`整包上传失败，回退为逐文件上传：${uploadError}`, "log-warning");
						}
					}
					if (!zipUploadPath || uploadError) {
						for (const item of prepared) {
							uploadError = await uploadAssemblyFiles({
								localDir: item.localDir,
								remoteDir: `${stagingRoot}/${item.module.name}`,
								files: item.files,
								username: uName,
								password: uPwd,
								server: serverAddress,
							});
							if (uploadError) break;
						}
					}
					if (uploadError) return false;
					const totalFiles = prepared.reduce((sum, item) => sum + item.files.length, 0);
					printInfoLog(
						`已将 ${moduleNames.length} 个模块共 ${totalFiles} 个文件上传到 ${stagingRoot}，耗时 ${formatElapsed(
							Date.now() - uploadStartTime
						)}.`,
						"log-success"
					);

					// 写入服务器上传日志：<程序集暂存路径>/上传日志.log（按模块逐行记录）
					// 非 WPF 记录每个模块目录上传的文件个数；WPF 记录具体上传文件及 zip 升级到的版本（解析本地 Manifest.xml）
					for (const item of prepared) {
						let uploadLogLine = `上传 ${item.module.name}：${item.files.length} 个文件（${stagingRoot}/${item.module.name}）`;
						if (item.module.name === MODULE_NAMES.wpfClient) {
							let versionText = "";
							try {
								const manifestResult = await cmdInvoke<string>("read_content_to_file", {
									filePath: `${removeSlash(item.localDir)}/Manifest.xml`,
								});
								if (manifestResult.code === 0 && manifestResult.data) {
									const versions = new Array<string>();
									const moduleRegex = /<Module>([\s\S]*?)<\/Module>/g;
									let match: RegExpExecArray | null;
									while ((match = moduleRegex.exec(String(manifestResult.data))) !== null) {
										const name = /<Name>([\s\S]*?)<\/Name>/.exec(match[1])?.[1]?.trim();
										const version = /<Version>([\s\S]*?)<\/Version>/.exec(match[1])?.[1]?.trim();
										if (name && version) versions.push(`${name}=${version}`);
									}
									if (versions.length > 0) versionText = `；版本：${versions.join("、")}`;
								}
							} catch (error) {
								printInfoLog(`读取本地 Manifest.xml 版本信息失败，上传日志将不含版本段.`, "log-warning");
							}
							uploadLogLine = `上传 ${item.module.name}：${item.files.join("、")}${versionText}`;
						}
						await appendRemoteLogLine({
							isWindows: Number(serverInfo.os) === 1,
							username: uName,
							password: uPwd,
							server: serverAddress,
							logPath: `${stagingRoot}/上传日志.log`,
							line: uploadLogLine,
						});
					}

					printInfoLog(
						`[上传-${moduleNames.join("、")}] ${serverInfo.name} 完成，总耗时 ${formatElapsed(Date.now() - tabStartTime)}.`,
						"log-success"
					);
					return true;
				})();
				if (!uploadSuccess) {
					isSuccess = false;
					break;
				}
			}
		} finally {
			// 清理本地整包（成功、失败、停止都清理）
			await cleanupBatchZip();
		}
		if (isSuccess) {
			printInfoLog(`上传程序集总耗时：${formatElapsed(Date.now() - overallStartTime)}。`);
		}
		return isSuccess;
	};

	// ==================== 服务管理 ====================

	/**
	 * 服务管理：根据服务器配置的服务，查看其最新的运行状态
	 */
	const getServiceStatuses = async (): Promise<DataResultType<ServiceStatusRow[]>> => {
		const result: DataResultType<ServiceStatusRow[]> = {
			code: 1,
			msg: "",
			data: [],
		};
		const instances = sortInstancesByServerThenModule(getServiceInstances().filter((ins) => ins.identity));
		if (instances.length < 1) {
			result.code = 1;
			result.msg = "应用配置中未找到带服务标识的服务，请检查应用配置.";
			return result;
		}

		// 已查询过的服务器/标识直接复用结果（同标识多实例时）
		const statusCache = new Map<string, { statusText: string; running: boolean | null }>();
		const rows: ServiceStatusRow[] = [];
		let hasError = false;
		// 分组日志：进入新服务器时输出一次【服务器】行，使日志顺序与界面分组的「服务器 → 服务器内发布模块顺序」一致
		let lastServerId: number | null = null;

		for (const ins of instances) {
			// 支持停止控制：请求停止后立即返回已查询到的结果
			if (checkStop()) {
				result.code = 1;
				result.msg = `查询已手动停止（已获取 ${rows.length} 条结果）`;
				result.data = rows;
				return result;
			}
			const cacheKey = `${ins.serverId}_${ins.identity}`;
			let status = statusCache.get(cacheKey);
			if (!status) {
				const serverInfo = await getServerDetail(ins.serverId);
				const isNewServer = lastServerId !== ins.serverId;
				if (!serverInfo) {
					status = { statusText: "服务器不存在", running: null };
					if (isNewServer) {
						printInfoLog(`【服务器】ID:${ins.serverId}（服务器不存在）`, "log-error");
					}
				} else {
					const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;
					if (isNewServer) {
						const serverInstanceCount = instances.filter((item) => item.serverId === ins.serverId).length;
						printInfoLog(
							`【服务器】${serverInfo.name}（${serverAddress}，${displayOs(Number(serverInfo.os))}）· ${serverInstanceCount} 个服务实例`
						);
					}
					if (serverInfo.os === 1) {
						printInfoLog(`查询服务状态：${serverInfo.name}（${serverAddress}，${displayOs(Number(serverInfo.os))}）sc query "${ins.identity}"`);
						const queryResult = await execRemote({
							username: serverInfo.account,
							password: serverInfo.pwd,
							server: serverAddress,
							command: `sc query "${ins.identity}"`,
						});
						const output = String(queryResult.data || "");
						if (queryResult.code !== 0) {
							status = { statusText: "查询失败", running: null };
							printInfoLog(`服务状态查询失败：${serverInfo.name} / ${ins.identity}：${queryResult.data}`, "log-error");
						} else if (output.includes("RUNNING")) {
							status = { statusText: "运行中", running: true };
						} else if (output.includes("STOPPED")) {
							status = { statusText: "已停止", running: false };
						} else {
							status = { statusText: "未找到服务", running: null };
							printInfoLog(`服务状态查询：${serverInfo.name} 未找到服务 ${ins.identity}`, "log-warning");
						}
					} else if (serverInfo.os === 2) {
						printInfoLog(`查询服务状态：${serverInfo.name}（${serverAddress}，${displayOs(Number(serverInfo.os))}）docker inspect ${ins.identity}`);
						const queryResult = await execRemote({
							username: serverInfo.account,
							password: serverInfo.pwd,
							server: serverAddress,
							command: `docker inspect -f '{{.State.Status}}' ${ins.identity}`,
						});
						const output = String(queryResult.data || "").trim();
						if (queryResult.code !== 0 || !output) {
							status = { statusText: "未找到容器", running: null };
							printInfoLog(`服务状态查询：${serverInfo.name} 未找到容器 ${ins.identity}`, "log-warning");
						} else if (output === "running") {
							status = { statusText: "运行中", running: true };
						} else if (output === "exited" || output === "dead") {
							status = { statusText: "已停止", running: false };
						} else {
							status = { statusText: output, running: null };
						}
					} else {
						status = { statusText: `未知环境(${displayOs(Number(serverInfo.os))})`, running: null };
						printInfoLog(`服务状态查询：${serverInfo.name} 为未知部署环境（${displayOs(Number(serverInfo.os))}）`, "log-error");
					}
				}
				lastServerId = ins.serverId;
				statusCache.set(cacheKey, status);
			}
			rows.push({
				module: ins.module,
				serverId: ins.serverId,
				serverName: ins.serverName,
				identity: ins.identity,
				statusText: status.statusText,
				running: status.running,
			});
		}

		// 结束汇总
		if (rows.length > 0) {
			const runningCount = rows.filter((r) => r.running === true).length;
			const stoppedCount = rows.filter((r) => r.running === false).length;
			const unknownCount = rows.length - runningCount - stoppedCount;
			printInfoLog(
				`服务状态查询完成：${rows.length} 个实例（运行中 ${runningCount} / 已停止 ${stoppedCount} / 未知 ${unknownCount}）`
			);
			// 按服务器维度再汇总一行，便于与界面分组核对（单服务器场景不输出，避免冗余）
			const serverSummaries = new Map<number, { name: string; running: number; total: number }>();
			for (const row of rows) {
				const summary = serverSummaries.get(row.serverId) || {
					name: row.serverName || `ID:${row.serverId}`,
					running: 0,
					total: 0,
				};
				summary.total += 1;
				if (row.running === true) summary.running += 1;
				serverSummaries.set(row.serverId, summary);
			}
			if (serverSummaries.size > 1) {
				const summaryText = [...serverSummaries.values()]
					.map((item) => `${item.name} 运行中 ${item.running}/${item.total}`)
					.join("、");
				printInfoLog(`各服务器：${summaryText}`);
			}
		}

		result.code = hasError ? 1 : 0;
		result.msg = "查询服务状态完成";
		result.data = rows;
		return result;
	};

	/**
	 * 服务操作（停止/启动/重启）：服务管理对话框的单行与批量操作共用
	 * 重启 = 先停止（等待完全停止）再启动；日志写入总体日志
	 */
	const controlService = async (row: ServiceStatusRow, action: ServiceControlAction) => {
		if (checkStop()) return false;
		const actionText = action === "stop" ? "停止" : action === "start" ? "启动" : "重启";
		const rowLabel = `${row.module} / ${row.serverName} / ${row.identity}`;
		const serverInfo = await getServerDetail(row.serverId);
		if (!serverInfo) {
			printInfoLog(`服务[${rowLabel}] 所在服务器(ID:${row.serverId})不存在，${actionText}失败.`, "log-error");
			return false;
		}
		const instance: ServiceInstanceType = {
			module: row.module,
			serverId: row.serverId,
			serverName: row.serverName,
			identity: row.identity,
			path: "",
		};
		printInfoLog(`服务[${rowLabel}] 开始${actionText}...`);
		const startTime = Date.now();
		let ok = true;
		if (action === "stop" || action === "restart") {
			ok = await stopInstanceService(serverInfo, instance);
			if (!ok) {
				printInfoLog(`服务[${rowLabel}] ${actionText}失败（停止阶段未完成）.`, "log-error");
				return false;
			}
		}
		if (action === "start" || action === "restart") {
			ok = await startInstanceService(serverInfo, instance);
		}
		if (ok) {
			printInfoLog(`服务[${rowLabel}] ${actionText}成功，耗时 ${formatElapsed(Date.now() - startTime)}.`, "log-success");
		} else {
			printInfoLog(`服务[${rowLabel}] ${actionText}失败，请查看上方日志.`, "log-error");
		}
		return ok;
	};

	// ==================== 查看服务端程序集 / 本机程序集 ====================

	// 生成列出目录内各子目录最新/最旧文件的 PowerShell 脚本
	// 输出格式：目录名|最新文件名|最新时间|最旧文件名|最旧时间
	const buildAssemblyListScript = (baseDir: string) => {
		return `Get-ChildItem -LiteralPath '${baseDir}' -Directory | ForEach-Object { $files = Get-ChildItem -LiteralPath $_.FullName -Recurse -File; if ($files) { $newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1; $oldest = $files | Sort-Object LastWriteTime | Select-Object -First 1; Write-Output ($_.Name + '|' + $newest.Name + '|' + $newest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') + '|' + $oldest.Name + '|' + $oldest.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')) } else { Write-Output ($_.Name + '|||') } }`;
	};

	// 解析目录清单输出为表格行
	const parseAssemblyOutput = (output: string, serverName: string): StagingAssemblyRow[] => {
		const rows: StagingAssemblyRow[] = [];
		const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.includes("|"));
		for (const line of lines) {
			const parts = line.split("|");
			rows.push({
				serverName,
				moduleName: parts[0] || "",
				latestFileName: parts[1] || "（无文件）",
				latestFileTime: parts[2] || "—",
				oldestFileName: parts[3] || "（无文件）",
				oldestFileTime: parts[4] || "—",
			});
		}
		return rows;
	};

	/**
	 * 查看服务端程序集：根据服务器配置的程序集暂存路径，
	 * 读取每个子目录内最新文件的文件名与修改时间、最旧文件的文件名与修改时间
	 */
	const getStagingAssemblies = async (): Promise<DataResultType<StagingAssemblyRow[]>> => {
		const result: DataResultType<StagingAssemblyRow[]> = {
			code: 1,
			msg: "",
			data: [],
		};

		// 参与发布的服务器（去重）
		const instances = getServiceInstances();
		if (instances.length < 1) {
			result.msg = "应用配置中未找到任何服务，请检查应用配置.";
			return result;
		}
		const serverIds = [...new Set(instances.map((ins) => ins.serverId))];
		const rows: StagingAssemblyRow[] = [];
		let errorMsg = "";

		for (const serverId of serverIds) {
			// 支持停止控制：请求停止后立即返回已查询到的结果
			if (checkStop()) {
				result.code = 1;
				result.msg = `查询已手动停止（已获取 ${rows.length} 条结果）`;
				result.data = rows;
				return result;
			}
			const serverInfo = await getServerDetail(serverId);
			if (!serverInfo) {
				errorMsg += `服务[ID:${serverId}]不存在；`;
				printInfoLog(`服务[ID:${serverId}]不存在，跳过读取.`, "log-error");
				continue;
			}
			if (!serverInfo.assemblyStagingPath) {
				errorMsg += `服务器[${serverInfo.name}]未配置[程序集暂存路径]；`;
				printInfoLog(`服务器[${serverInfo.name}]未配置[程序集暂存路径]，跳过读取.`, "log-error");
				continue;
			}
			const stagingBase = removeSlash(String(serverInfo.assemblyStagingPath));
			const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;
			printInfoLog(`读取服务器程序集清单：${serverInfo.name}（${serverAddress}，${displayOs(Number(serverInfo.os))}）${stagingBase}`);

			let queryResult;
			if (serverInfo.os === 1) {
				const cmd = `powershell -Command "${buildAssemblyListScript(stagingBase)}"`;
				queryResult = await execRemote({
					username: serverInfo.account,
					password: serverInfo.pwd,
					server: serverAddress,
					command: cmd,
				});
			} else {
				const cmd = `cd '${stagingBase}' 2>/dev/null || exit 1; for d in */; do name="\${d%/}"; all=$(find "$d" -type f -printf '%T@|%TY-%Tm-%Td %TH:%TM:%TS|%p\\n' 2>/dev/null | sort -n); if [ -n "$all" ]; then newest=$(printf '%s\\n' "$all" | tail -1); oldest=$(printf '%s\\n' "$all" | head -1); nt=$(printf '%s' "$newest" | cut -d'|' -f2 | cut -d. -f1); np=$(printf '%s' "$newest" | cut -d'|' -f3-); np="\${np##*/}"; ot=$(printf '%s' "$oldest" | cut -d'|' -f2 | cut -d. -f1); op=$(printf '%s' "$oldest" | cut -d'|' -f3-); op="\${op##*/}"; echo "$name|$np|$nt|$op|$ot"; else echo "$name|||"; fi; done`;
				queryResult = await execRemote({
					username: serverInfo.account,
					password: serverInfo.pwd,
					server: serverAddress,
					command: cmd,
				});
			}
			if (queryResult.code !== 0) {
				errorMsg += `服务器[${serverInfo.name}]读取暂存路径失败：${queryResult.data}；`;
				printInfoLog(`服务器[${serverInfo.name}]读取暂存路径失败：${queryResult.data}`, "log-error");
				continue;
			}
			const output = String(queryResult.data || "");
			const serverRows = parseAssemblyOutput(output, serverInfo.name || "");
			if (serverRows.length < 1) {
				errorMsg += `服务器[${serverInfo.name}]暂存路径为空或无子目录；`;
				printInfoLog(`服务器[${serverInfo.name}]暂存路径为空或无子目录.`, "log-warning");
				continue;
			}
			rows.push(...serverRows);
		}

		result.code = rows.length > 0 ? 0 : 1;
		result.msg = rows.length > 0 ? "查询服务端程序集完成" : errorMsg || "未查询到服务端程序集";
		result.data = rows;
		return result;
	};

	/**
	 * 查看本机程序集：根据程序集输出路径（输出路径\项目\环境），
	 * 读取每个模块目录内最新文件的文件名与修改时间、最旧文件的文件名与修改时间
	 */
	const getLocalAssemblies = async (): Promise<DataResultType<StagingAssemblyRow[]>> => {
		const result: DataResultType<StagingAssemblyRow[]> = {
			code: 1,
			msg: "",
			data: [],
		};

		const localBase = removeSlash(ctx.assemblyOutPath());
		if (!localBase) {
			result.msg = "未获取到本机程序集输出路径，请先选择项目与环境.";
			return result;
		}
		const existsResult = await cmdInvoke("exists", { path: localBase });
		if (existsResult.code !== 0) {
			result.msg = `本机程序集输出路径不存在：${localBase}，请先执行【获取程序集】.`;
			return result;
		}

		const execResult = await cmdInvoke("execute_local_command", {
			command: "powershell",
			args: ["-Command", buildAssemblyListScript(localBase)],
		});
		if (execResult.code !== 0) {
			result.msg = `读取本机程序集输出路径失败：${execResult.data}`;
			return result;
		}

		const rows = parseAssemblyOutput(String(execResult.data || ""), "本机");
		result.code = rows.length > 0 ? 0 : 1;
		result.msg =
			rows.length > 0 ? "查询本机程序集完成" : "本机程序集输出路径为空或无模块目录，请先执行【获取程序集】.";
		result.data = rows;
		return result;
	};

	// ==================== 核对程序集 ====================

	// Unix 秒 → 展示用时间字符串（本机时区，双方同基准便于比对）
	const formatEpochSeconds = (seconds: number): string => {
		const d = new Date(seconds * 1000);
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	};

	// 生成递归列出目录内全部文件的脚本
	// 输出格式：相对路径|Unix时间戳秒（UTC 基准，避免跨机时区差异）
	const buildFileListScript = (dir: string, isWindows: boolean) => {
		if (isWindows) {
			return `Get-ChildItem -LiteralPath '${dir}' -Recurse -File | ForEach-Object { Write-Output ($_.FullName.Substring('${dir}'.Length).TrimStart('\\') + '|' + $_.LastWriteTimeUtc.Subtract([datetime]'1970-01-01').TotalSeconds) }`;
		}
		return `find '${dir}' -type f -printf '%P|%T@\\n'`;
	};

	// 解析逐文件清单输出为 相对路径 → Unix秒 映射（统一斜杠、秒数取整）
	const parseFileListOutput = (output: string): Map<string, number> => {
		const map = new Map<string, number>();
		const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.includes("|"));
		for (const line of lines) {
			const idx = line.indexOf("|");
			const file = line.slice(0, idx).replace(/\\/g, "/");
			const seconds = Math.floor(Number(line.slice(idx + 1)));
			if (!file || !Number.isFinite(seconds)) continue;
			map.set(file, seconds);
		}
		return map;
	};

	/**
	 * 核对程序集：以本机程序集为准，逐文件比对各服务器程序集暂存路径中对应模块目录的文件修改时间，
	 * 统计每个服务器中每个程序集目录的差异项（服务器缺失文件 / 修改时间不一致 / 服务器多出文件）；
	 * 服务器多出的文件（本地已无）同样视为差异，计入差异合计并影响「是否一致」判定
	 */
	const checkAssemblies = async (): Promise<DataResultType<AssemblyDiffRow[]>> => {
		const result: DataResultType<AssemblyDiffRow[]> = {
			code: 1,
			msg: "",
			data: [],
		};

		const localBase = removeSlash(ctx.assemblyOutPath());
		if (!localBase) {
			result.msg = "未获取到本机程序集输出路径，请先选择项目与环境.";
			return result;
		}
		const modules = getStepModules();
		if (modules.length < 1) {
			result.msg = "应用配置中未找到任何模块，请先检查应用配置.";
			return result;
		}
		const existsResult = await cmdInvoke("exists", { path: localBase });
		if (existsResult.code !== 0) {
			result.msg = `本机程序集输出路径不存在：${localBase}，请先执行【获取程序集】.`;
			return result;
		}

		// 本机程序集清单（一次递归列出全部文件）
		const localExec = await cmdInvoke("execute_local_command", {
			command: "powershell",
			args: ["-Command", buildFileListScript(localBase, true)],
		});
		if (localExec.code !== 0) {
			result.msg = `读取本机程序集输出路径失败：${localExec.data}`;
			return result;
		}
		const localMap = parseFileListOutput(String(localExec.data || ""));
		if (localMap.size < 1) {
			result.msg = "本机程序集输出路径为空或无文件，请先执行【获取程序集】.";
			return result;
		}

		// 参与核对的服务器 = 上传目标服务器（各模块 serverArr 去重）
		const serverItems = [
			...new Map(
				modules
					.flatMap((m) => m.serverArr)
					.filter((s) => s.id)
					.map((s) => [Number(s.id), s])
			).values(),
		];
		if (serverItems.length < 1) {
			result.msg = "应用配置中未找到任何服务器，请检查应用配置.";
			return result;
		}
		printInfoLog(`开始核对程序集：本机 ${localMap.size} 个文件，${serverItems.length} 台服务器`);

		const rows: AssemblyDiffRow[] = [];
		let errorMsg = "";

		for (const serverItem of serverItems) {
			// 支持停止控制：请求停止后立即返回已核对到的结果
			if (checkStop()) {
				result.code = 1;
				result.msg = `核对已手动停止（已获取 ${rows.length} 条结果）`;
				result.data = rows;
				return result;
			}
			const serverId = Number(serverItem.id);
			const serverInfo = await getServerDetail(serverId);
			if (!serverInfo) {
				errorMsg += `服务器[ID:${serverId}]不存在；`;
				printInfoLog(`服务器[ID:${serverId}]不存在，跳过核对.`, "log-error");
				continue;
			}
			if (!serverInfo.assemblyStagingPath) {
				errorMsg += `服务器[${serverInfo.name}]未配置[程序集暂存路径]，请先在服务器管理中配置；`;
				printInfoLog(`服务器[${serverInfo.name}]未配置[程序集暂存路径]，跳过核对.`, "log-error");
				continue;
			}
			const stagingBase = removeSlash(String(serverInfo.assemblyStagingPath));
			const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;

			// 服务器程序集清单（一次递归列出全部文件）
			printInfoLog(`读取服务器程序集清单：${serverInfo.name}（${serverAddress}，${displayOs(Number(serverInfo.os))}）${stagingBase}`);
			let queryResult;
			if (serverInfo.os === 1) {
				queryResult = await execRemote({
					username: serverInfo.account,
					password: serverInfo.pwd,
					server: serverAddress,
					command: `powershell -Command "${buildFileListScript(stagingBase, true)}"`,
				});
			} else {
				queryResult = await execRemote({
					username: serverInfo.account,
					password: serverInfo.pwd,
					server: serverAddress,
					command: buildFileListScript(stagingBase, false),
				});
			}
			if (queryResult.code !== 0) {
				errorMsg += `服务器[${serverInfo.name}]读取程序集暂存路径失败：${queryResult.data}；`;
				printInfoLog(`服务器[${serverInfo.name}]读取程序集暂存路径失败：${queryResult.data}`, "log-error");
				continue;
			}
			const serverMap = parseFileListOutput(String(queryResult.data || ""));
			printInfoLog(`服务器[${serverInfo.name}]共 ${serverMap.size} 个文件，开始逐模块比对...`);

			// 逐模块比对（仅核对会上传到该服务器的模块）
			for (const module of modules) {
				if (!module.serverArr.some((s) => Number(s.id) === serverId)) continue;

				// 本地子清单前缀：WpfClient 为打包产出目录 packOutput/<服务器id>，其余为模块目录
				const localPrefix =
					module.name === MODULE_NAMES.wpfClient
						? `${MODULE_NAMES.wpfClient}/packOutput/${serverId}/`
						: `${module.name}/`;
				const localFiles = new Map<string, number>();
				for (const [file, seconds] of localMap) {
					if (file.startsWith(localPrefix)) localFiles.set(file.slice(localPrefix.length), seconds);
				}
				// 服务器子清单：<暂存路径>/<模块名>/
				const serverPrefix = `${module.name}/`;
				const serverFiles = new Map<string, number>();
				for (const [file, seconds] of serverMap) {
					if (file.startsWith(serverPrefix)) serverFiles.set(file.slice(serverPrefix.length), seconds);
				}

				if (localFiles.size < 1) {
					errorMsg +=
						module.name === MODULE_NAMES.wpfClient
							? `服务器[${serverInfo.name}]未找到本机打包目录 ${localBase}/${localPrefix.replace(/\/$/, "")}，请先执行【打包WPF】；`
							: `服务器[${serverInfo.name}]未找到本机程序集目录 ${localBase}/${module.name}，请先执行【获取程序集】；`;
					printInfoLog(
						module.name === MODULE_NAMES.wpfClient
							? `未找到本机打包目录 ${localBase}/${localPrefix.replace(/\/$/, "")}，请先执行【打包WPF】.`
							: `未找到本机程序集目录 ${localBase}/${module.name}，请先执行【获取程序集】.`,
						"log-error"
					);
					continue;
				}

				// 以本地为准逐文件核对
				const details: AssemblyDiffDetail[] = [];
				let missingCount = 0;
				let timeDiffCount = 0;
				for (const [file, localSeconds] of localFiles) {
					const serverSeconds = serverFiles.get(file);
					if (serverSeconds === undefined) {
						missingCount++;
						details.push({
							type: "missing",
							file,
							localTime: formatEpochSeconds(localSeconds),
							serverTime: "—（缺失）",
						});
					} else if (Math.abs(serverSeconds - localSeconds) > MTIME_TOLERANCE_SECONDS) {
						timeDiffCount++;
						details.push({
							type: "timeDiff",
							file,
							localTime: formatEpochSeconds(localSeconds),
							serverTime: formatEpochSeconds(serverSeconds),
						});
					}
				}
				// 服务器多出文件（本地已无）：同样视为差异，计入差异合计
				// 服务器侧修改时间照常输出，便于判断这个残留文件是哪一次上传留下的
				let extraCount = 0;
				for (const [file, serverSeconds] of serverFiles) {
					if (!localFiles.has(file)) {
						extraCount++;
						details.push({
							type: "extra",
							file,
							localTime: "—（本地无此文件）",
							serverTime: formatEpochSeconds(serverSeconds),
						});
					}
				}
				details.sort((a, b) => {
					const order: Record<string, number> = { missing: 0, timeDiff: 1, extra: 2 };
					return order[a.type] - order[b.type] || a.file.localeCompare(b.file);
				});
				const diffCount = missingCount + timeDiffCount + extraCount;

				rows.push({
					serverId,
					serverName: serverInfo.name || "",
					moduleName: module.name,
					localCount: localFiles.size,
					serverCount: serverFiles.size,
					missingCount,
					timeDiffCount,
					extraCount,
					diffCount,
					consistent: diffCount === 0,
					details,
				});
			}
		}

		// 排序：服务器名 → 差异行靠前 → 模块名
		rows.sort(
			(a, b) =>
				a.serverName.localeCompare(b.serverName) ||
				Number(a.consistent) - Number(b.consistent) ||
				a.moduleName.localeCompare(b.moduleName)
		);

		// 结束汇总
		if (rows.length > 0) {
			const diffRows = rows.filter((r) => !r.consistent).length;
			const missingTotal = rows.reduce((sum, r) => sum + r.missingCount, 0);
			const timeDiffTotal = rows.reduce((sum, r) => sum + r.timeDiffCount, 0);
			const extraTotal = rows.reduce((sum, r) => sum + r.extraCount, 0);
			printInfoLog(
				`核对完成：共 ${rows.length} 行，差异 ${diffRows} 行（缺失 ${missingTotal} / 时间不一致 ${timeDiffTotal} / 服务器多出 ${extraTotal}）`,
				diffRows > 0 ? "log-warning" : "log-success"
			);
		}

		result.code = rows.length > 0 ? 0 : 1;
		result.msg = rows.length > 0 ? errorMsg : errorMsg || "未查询到可核对的程序集";
		result.data = rows;
		return result;
	};

	// ==================== 查看服务备份 ====================

	/**
	 * 查看服务备份：根据服务器配置的服务备份路径，
	 * 读取每个服务器备份目录内按名称降序的第一个日期文件夹（即最近一次备份），
	 * 并列出其一级目录内条目明细（即该日期备份了哪些服务）
	 */
	const getServiceBackups = async (): Promise<DataResultType<ServiceBackupRow[]>> => {
		const result: DataResultType<ServiceBackupRow[]> = {
			code: 1,
			msg: "",
			data: [],
		};

		// 参与发布的服务器（去重）
		const instances = getServiceInstances();
		if (instances.length < 1) {
			result.msg = "应用配置中未找到任何服务，请检查应用配置.";
			return result;
		}
		const serverIds = [...new Set(instances.map((ins) => ins.serverId))];
		const rows: ServiceBackupRow[] = [];
		let errorMsg = "";

		for (const serverId of serverIds) {
			// 支持停止控制：请求停止后立即返回已查询到的结果
			if (checkStop()) {
				result.code = 1;
				result.msg = `查询已手动停止（已获取 ${rows.length} 条结果）`;
				result.data = rows;
				return result;
			}
			const serverInfo = await getServerDetail(serverId);
			if (!serverInfo) {
				errorMsg += `服务[ID:${serverId}]不存在；`;
				printInfoLog(`服务[ID:${serverId}]不存在，跳过读取.`, "log-error");
				continue;
			}
			if (!serverInfo.serviceBackupPath) {
				errorMsg += `服务器[${serverInfo.name}]未配置[服务备份路径]；`;
				printInfoLog(`服务器[${serverInfo.name}]未配置[服务备份路径]，跳过读取.`, "log-error");
				continue;
			}
			const backupBase = removeSlash(String(serverInfo.serviceBackupPath));
			const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;
			printInfoLog(`读取服务备份清单：${serverInfo.name}（${serverAddress}，${displayOs(Number(serverInfo.os))}）${backupBase}`);

			let queryResult;
			if (serverInfo.os === 1) {
				const cmd = `powershell -Command "Get-ChildItem -LiteralPath '${backupBase}' -Directory | Sort-Object Name -Descending | Select-Object -First 10 | ForEach-Object { $items = (Get-ChildItem -LiteralPath $_.FullName | ForEach-Object { $_.Name }) -join ','; Write-Output ($_.Name + '|' + $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') + '|' + $items) }"`;
				queryResult = await execRemote({
					username: serverInfo.account,
					password: serverInfo.pwd,
					server: serverAddress,
					command: cmd,
				});
			} else {
				const cmd = `cd '${backupBase}' 2>/dev/null || exit 1; for d in $(ls -1 | sort -r | head -10); do [ -d "$d" ] || continue; items=$(ls -1 "$d" 2>/dev/null | paste -sd, -); echo "$d|$(date -r "$d" '+%Y-%m-%d %H:%M:%S')|$items"; done`;
				queryResult = await execRemote({
					username: serverInfo.account,
					password: serverInfo.pwd,
					server: serverAddress,
					command: cmd,
				});
			}
			if (queryResult.code !== 0) {
				errorMsg += `服务器[${serverInfo.name}]读取服务备份路径失败：${queryResult.data}；`;
				printInfoLog(`服务器[${serverInfo.name}]读取服务备份路径失败：${queryResult.data}`, "log-error");
				continue;
			}
			const lines = String(queryResult.data || "")
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.includes("|"));
			if (lines.length < 1) {
				errorMsg += `服务器[${serverInfo.name}]服务备份路径为空或无备份文件夹；`;
				printInfoLog(`服务器[${serverInfo.name}]服务备份路径为空或无备份文件夹.`, "log-warning");
				continue;
			}
			for (const line of lines) {
				const parts = line.split("|");
				const folderName = parts[0] || "";
				const services = (parts[2] || "").split(",").filter((s) => s.trim() !== "");
				rows.push({
					serverId: serverId,
					serverName: serverInfo.name || "",
					backupBase: backupBase,
					backupDate: folderName,
					backupPath: `${backupBase}/${folderName}`,
					backupTime: parts[1] || "—",
					serviceCount: services.length,
					services,
				});
			}
		}

		result.code = rows.length > 0 ? 0 : 1;
		result.msg = rows.length > 0 ? "查询服务备份完成" : errorMsg || "未查询到服务备份";
		result.data = rows;
		return result;
	};

	/**
	 * 删除服务备份：将备份文件夹及其内容从服务器上删除（删除前由界面二次确认）
	 */
	const deleteServiceBackup = async (row: ServiceBackupRow) => {
		const result: DataResultType<boolean> = { code: 1, msg: "", data: false };
		const serverInfo = await getServerDetail(row.serverId);
		if (!serverInfo) {
			result.msg = `服务器[ID:${row.serverId}]不存在，删除失败.`;
			return result;
		}
		// 安全校验：待删除路径必须位于该服务器配置的服务备份路径下
		if (!row.backupBase || !removeSlash(row.backupPath).startsWith(`${removeSlash(row.backupBase)}/`)) {
			result.msg = `备份路径异常（${row.backupPath}），已取消删除.`;
			return result;
		}
		const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;
		let deleteResult;
		if (serverInfo.os === 1) {
			deleteResult = await execRemote({
				username: serverInfo.account,
				password: serverInfo.pwd,
				server: serverAddress,
				command: `powershell -Command "Remove-Item -LiteralPath '${row.backupPath}' -Recurse -Force"`,
			});
		} else {
			deleteResult = await execRemote({
				username: serverInfo.account,
				password: serverInfo.pwd,
				server: serverAddress,
				command: `rm -rf '${row.backupPath}'`,
			});
		}
		if (deleteResult.code !== 0) {
			result.msg = `删除备份 ${row.backupPath} 失败：${deleteResult.data}`;
			return result;
		}
		result.code = 0;
		result.msg = `已删除备份 ${row.backupPath}`;
		result.data = true;
		return result;
	};

	// 查询指定服务器的服务实例（恢复备份弹窗的「恢复服务」下拉数据）
	const getServiceInstancesByServer = (serverId: number) => {
		return getServiceInstances().filter((ins) => ins.serverId === serverId);
	};

	/**
	 * 恢复服务备份：停止服务 → 将备份文件夹一级目录中的所有 DLL 替换到恢复服务对应文件夹 → 启动服务
	 * （无服务标识的实例跳过停止/启动）
	 */
	const restoreServiceBackup = async (params: {
		serverId: number;
		backupFolderName: string;
		backupPath: string;
		module: string;
		servicePath: string;
		identity: string;
	}) => {
		const result: DataResultType<boolean> = { code: 1, msg: "", data: false };
		const serverInfo = await getServerDetail(params.serverId);
		if (!serverInfo) {
			result.msg = `服务器[ID:${params.serverId}]不存在，恢复失败.`;
			return result;
		}
		// 安全校验：备份路径必须位于该服务器配置的服务备份路径下
		if (
			!serverInfo.serviceBackupPath ||
			!removeSlash(params.backupPath).startsWith(`${removeSlash(String(serverInfo.serviceBackupPath))}/`)
		) {
			result.msg = `备份路径异常（${params.backupPath}），已取消恢复.`;
			return result;
		}
		const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;
		const instance: ServiceInstanceType = {
			module: params.module,
			serverId: params.serverId,
			serverName: serverInfo.name || "",
			identity: params.identity,
			path: params.servicePath,
		};
		const hasService = Boolean(params.identity);
	const rowLabel = `${params.module} / ${serverInfo.name} / ${params.identity || "无服务标识"}`;
	const startTime = Date.now();
	// 支持停止控制：入口已请求停止则不开始
	if (checkStop()) {
		result.msg = "已手动停止，恢复未开始";
		return result;
	}
	printInfoLog(`服务[${rowLabel}] 开始恢复备份「${params.backupFolderName}」...`);

		// 1. 停止服务
		if (hasService) {
			printInfoLog(`恢复步骤 1/3：停止服务...`);
			const stopOk = await stopInstanceService(serverInfo, instance);
			if (!stopOk) {
				printInfoLog(`服务[${rowLabel}] 恢复失败（停止服务未完成）.`, "log-error");
				result.msg = "停止服务失败，恢复已中止";
				return result;
			}
		} else {
			printInfoLog(`恢复步骤 1/3：无服务标识，跳过停止服务.`);
		}
		// 步骤间停止检查：服务已停止时中止恢复需明确提示
		if (checkStop()) {
			if (hasService) {
				printInfoLog(`服务[${rowLabel}] 恢复已手动停止（服务处于停止状态，请手动启动或再次执行恢复）.`, "log-warning");
			}
			result.msg = "已手动停止，恢复中止";
			return result;
		}

		// 2. 将备份文件夹内容替换到恢复服务对应文件夹（WpfClient 替换全部文件，其余仅替换一级目录中的所有 DLL）
		const servicePath = removeSlash(params.servicePath);
		const isWpfClient = params.module.toLowerCase() === MODULE_NAMES.wpfClient.toLowerCase();
		const copyDesc = isWpfClient ? "全部文件" : "一级目录中的所有 DLL";
		printInfoLog(`恢复步骤 2/3：将备份文件夹 ${params.backupPath} 的${copyDesc}替换到 ${servicePath}...`);
		const copyStartTime = Date.now();
		let copyResult;
		if (serverInfo.os === 1) {
			const copyPattern = isWpfClient ? `${params.backupPath}\\*` : `${params.backupPath}\\*.dll`;
			const recurseArg = isWpfClient ? " -Recurse" : "";
			copyResult = await execRemote({
				username: serverInfo.account,
				password: serverInfo.pwd,
				server: serverAddress,
				command: `powershell -Command "if (-not (Test-Path -LiteralPath '${params.backupPath}')) { Write-Output 'BACKUP_NOT_FOUND'; exit 1 }; if (-not (Test-Path -LiteralPath '${servicePath}')) { New-Item -ItemType Directory -Force -Path '${servicePath}' | Out-Null }; Copy-Item -Path '${copyPattern}' -Destination '${servicePath}'${recurseArg} -Force"`,
			});
		} else {
			const findArgs = isWpfClient
				? `find '${params.backupPath}' -mindepth 1 -exec cp -a {} '${servicePath}/' \\;`
				: `find '${params.backupPath}' -maxdepth 1 -type f -name '*.dll' -exec cp -f {} '${servicePath}/' \\;`;
			copyResult = await execRemote({
				username: serverInfo.account,
				password: serverInfo.pwd,
				server: serverAddress,
				command: `test -d '${params.backupPath}' || { echo 'BACKUP_NOT_FOUND'; exit 1; }; mkdir -p '${servicePath}'; ${findArgs}`,
			});
		}
		if (copyResult.code !== 0) {
			printInfoLog(`恢复步骤 2/3 失败：${copyResult.data}`, "log-error");
			if (hasService) {
				printInfoLog(`服务已停止且未完成恢复，请检查备份文件夹后手动处理，或再次执行恢复.`, "log-warning");
			}
			result.msg = `替换文件失败：${copyResult.data}`;
			return result;
		}
		printInfoLog(`${copyDesc}替换完成，耗时 ${formatElapsed(Date.now() - copyStartTime)}.`, "log-success");

		// 3. 启动服务
		if (hasService) {
			printInfoLog(`恢复步骤 3/3：启动服务...`);
			const startOk = await startInstanceService(serverInfo, instance);
			if (!startOk) {
				printInfoLog(`服务[${rowLabel}] 恢复后启动服务失败，请手动检查.`, "log-error");
				result.msg = "启动服务失败";
				return result;
			}
		} else {
			printInfoLog(`恢复步骤 3/3：无服务标识，跳过启动服务.`);
		}
		// 步骤间停止检查：文件已替换但服务未启动时需明确提示
		if (checkStop()) {
			if (hasService) {
				printInfoLog(`服务[${rowLabel}] 恢复已手动停止（文件已替换，服务处于停止状态，请手动启动或再次执行恢复）.`, "log-warning");
			}
			result.msg = "已手动停止，恢复中止";
			return result;
		}
		printInfoLog(`服务[${rowLabel}] 恢复完成，总耗时 ${formatElapsed(Date.now() - startTime)}.`, "log-success");

		// 写入服务器恢复日志：<服务备份路径>/恢复日志.log，记录恢复的备份时间文件夹、服务文件夹与恢复目标路径
		const restorePathSegments = removeSlash(params.backupPath).split("/");
		const restoreDateFolder = restorePathSegments.length >= 2 ? restorePathSegments[restorePathSegments.length - 2] : "";
		const restoreServiceFolder = restorePathSegments[restorePathSegments.length - 1] || params.backupFolderName;
		await appendRemoteLogLine({
			isWindows: Number(serverInfo.os) === 1,
			username: serverInfo.account,
			password: serverInfo.pwd,
			server: serverAddress,
			logPath: `${removeSlash(String(serverInfo.serviceBackupPath))}/恢复日志.log`,
			line: `恢复 ${restoreDateFolder}/${restoreServiceFolder} → ${servicePath}`,
		});
		result.code = 0;
		result.msg = "恢复成功";
		result.data = true;
		return result;
	};

	// ==================== 发布 ====================

	/**
	 * 发布：停止服务 → 将服务器上程序集暂存路径的程序集替换到服务路径 → 开启服务
	 */
	const stepPublish = async () => {
		resetStopState();
		const instances = getServiceInstances();
		if (instances.length < 1) {
			printInfoLog("应用配置中未找到任何服务，请检查.", "log-error");
			return false;
		}
		if (!validateInstances(instances)) return false;
		printInfoLog("");

		// 按服务器分组
		const serverMap = new Map<number, ServiceInstanceType[]>();
		for (const ins of instances) {
			const list = serverMap.get(ins.serverId) || [];
			list.push(ins);
			serverMap.set(ins.serverId, list);
		}

		// 入口信息
		const totalInstanceCount = instances.length;
		printInfoLog(
			`发布流程：停止服务 → 暂存路径程序集替换服务路径 → 开启服务（共 ${serverMap.size} 台服务器、${totalInstanceCount} 个服务实例）`
		);
		const overallStartTime = Date.now();

		let isSuccess = true;
		for (const [serverId, serverInstances] of serverMap) {
			if (checkStop()) return false;
			const serverInfo = await getServerDetail(serverId);
			if (!serverInfo) {
				printInfoLog(`服务[ID:${serverId}]不存在，请检查.`, "log-error");
				return false;
			}
			if (!serverInfo.assemblyStagingPath) {
				printInfoLog(`服务器[${serverInfo.name}]未配置[程序集暂存路径]，请先在服务器管理中配置.`, "log-error");
				return false;
			}
			const stagingBase = removeSlash(String(serverInfo.assemblyStagingPath));
			printInfoLog(
				`服务器[${serverInfo.name}]：暂存路径 ${stagingBase}，待发布 ${serverInstances.length} 个服务实例`
			);

			for (const ins of serverInstances) {
				// 停止检查：实例一旦开始发布则完整执行（停止→替换→启动），避免留下已停止的服务
				if (checkStop()) return false;
				const instanceStartTime = Date.now();
				const instanceSuccess = await (async () => {
					const uName = serverInfo.account;
					const uPwd = serverInfo.pwd;
					const serverAddress = `${serverInfo.ip}:${serverInfo.port}`;
					const logPrefix = formatServiceLog(serverInfo.name, serverInfo.ip, ins.module, ins.identity);
					const hasService = Boolean(ins.identity);
					const targetText = `${ins.module}${hasService ? `（${ins.identity}）` : "（仅文件）"} → ${removeSlash(ins.path)}`;
					// 失败时写入服务器发布日志：发布失败 <目标>：<原因>
					const writeFailLog = async (reason: string) => {
						await appendRemoteLogLine({
							isWindows: Number(serverInfo.os) === 1,
							username: uName,
							password: uPwd,
							server: serverAddress,
							logPath: `${stagingBase}/发布日志.log`,
							line: `发布失败 ${targetText}：${reason}`,
						});
					};
					// 发布开始：写入服务器发布日志
					await appendRemoteLogLine({
						isWindows: Number(serverInfo.os) === 1,
						username: uName,
						password: uPwd,
						server: serverAddress,
						logPath: `${stagingBase}/发布日志.log`,
						line: `发布开始 ${targetText}`,
					});
					printInfoLog(
						`发布目标：${ins.module}${ins.identity ? `（服务标识 ${ins.identity}）` : "（无服务标识，仅替换文件）"} @ ${displayOs(Number(serverInfo.os))} ${serverAddress}`
					);
					printInfoLog(`发布路径：${removeSlash(ins.path)}`);

					/* 1.停止服务 */
					if (hasService) {
						printInfoLog(`步骤 1/3：停止服务...`);
						const stopStartTime = Date.now();
						printInfoLog(`${logPrefix} 正在关闭...`);
						const closeResult = await stopInstanceService(serverInfo, ins);
						if (!closeResult) {
							printInfoLog(`${logPrefix} 关闭失败.`, "log-error");
							await writeFailLog("关闭服务失败");
							return false;
						}
						printInfoLog(
							`${logPrefix} 已关闭，耗时 ${formatElapsed(Date.now() - stopStartTime)}.`,
							"log-success"
						);
					} else {
						printInfoLog(`步骤 1/3：无服务标识，跳过停止服务.`);
					}

					/* 2.将暂存路径的程序集替换到服务路径 */
					printInfoLog(`步骤 2/3：替换程序集（将暂存目录 ${stagingBase}/${ins.module} 的内容覆盖到发布路径 ${removeSlash(ins.path)}）...`);
					const replaceStartTime = Date.now();
					printInfoLog(`${logPrefix} 正在替换程序集：${stagingBase}/${ins.module} → ${removeSlash(ins.path)}`);
					let replaceResult;
					if (serverInfo.os === 1) {
						replaceResult = await execRemote({
							username: uName,
							password: uPwd,
							server: serverAddress,
							command: `powershell -Command "if (-not (Test-Path -LiteralPath '${stagingBase}/${ins.module}')) { Write-Output 'STAGING_NOT_FOUND'; exit 1 }; Copy-Item -Path '${stagingBase}/${ins.module}\\*' -Destination '${removeSlash(ins.path)}' -Recurse -Force"`,
						});
					} else if (serverInfo.os === 2) {
						replaceResult = await execRemote({
							username: uName,
							password: uPwd,
							server: serverAddress,
							command: `test -d '${stagingBase}/${ins.module}' || { echo 'STAGING_NOT_FOUND'; exit 1; }; mkdir -p '${removeSlash(ins.path)}'; cp -a '${stagingBase}/${ins.module}/.' '${removeSlash(ins.path)}/'`,
						});
					} else {
						printInfoLog(`未找到 ${displayOs(Number(serverInfo.os))} 部署环境，请检查.`, "log-error");
						await writeFailLog(`未找到 ${displayOs(Number(serverInfo.os))} 部署环境`);
						return false;
					}
				if (replaceResult.code !== 0) {
					printInfoLog(`替换程序集失败（${stagingBase}/${ins.module} → ${removeSlash(ins.path)}）：${replaceResult.data}`, "log-error");
					printInfoLog(`服务已停止且未完成替换，请检查暂存路径后手动恢复：可先执行【上传程序集】再重新【发布】，或手动启动服务.`, "log-warning");
					await writeFailLog("替换程序集失败");
					return false;
				}
				printInfoLog(
					`${logPrefix} 程序集替换完成，耗时 ${formatElapsed(Date.now() - replaceStartTime)}.`,
					"log-success"
				);

				/* 3.开启服务 */
				if (hasService) {
					printInfoLog(`步骤 3/3：开启服务...`);
					const startStartTime = Date.now();
					printInfoLog(`${logPrefix} 正在启动.`);
					const startResult = await startInstanceService(serverInfo, ins);
					if (!startResult) {
						printInfoLog(`${logPrefix} 启动失败.`, "log-error");
						await writeFailLog("启动服务失败");
						return false;
					}
					printInfoLog(`${logPrefix} 已启动，耗时 ${formatElapsed(Date.now() - startStartTime)}.`, "log-success");
				} else {
					printInfoLog(`步骤 3/3：无服务标识，跳过开启服务.`);
				}
				printInfoLog(
					`${logPrefix} 发布成功，总耗时 ${formatElapsed(Date.now() - instanceStartTime)}.`,
					"log-success"
				);

				// 写入服务器发布日志：<程序集暂存路径>/发布日志.log，记录发布了哪些服务（每实例一行）
				await appendRemoteLogLine({
					isWindows: Number(serverInfo.os) === 1,
					username: uName,
					password: uPwd,
					server: serverAddress,
					logPath: `${stagingBase}/发布日志.log`,
					line: `发布成功 ${targetText}`,
				});
				return true;
			})();
				if (!instanceSuccess) {
					isSuccess = false;
					break;
				}
			}
			if (!isSuccess) break;
		}
		if (isSuccess) {
			printInfoLog(`发布总耗时：${formatElapsed(Date.now() - overallStartTime)}。`);
		}
		return isSuccess;
	};

	// ==================== 获取程序集（与 home 同语义的独立实现） ====================

	// 构造TFS命令
	const getTfsDllFiles = async (selectTfsItem: SelectTfsType) => {
		// [最近时间]的范围每次动态计算，缓存键带上换算出的日期，避免同一会话跨天复用旧结果
		const recentKey =
			selectTfsItem.selectModel === "最近时间"
				? `:${getRecentDaysDateRange(Number(selectTfsItem.selectValue[0].value)).join("~")}`
				: "";
		const cacheKey = `TFS:${selectTfsItem.id}:${selectTfsItem.selectModel}:${JSON.stringify(selectTfsItem.selectValue)}${recentKey}`;
		const cachedFiles = assemblyFileListCache.get(cacheKey);
		if (cachedFiles) {
			printInfoLog(`  已复用本次运行的 TFS 查询结果（${cachedFiles.length} 个文件），无需再次查询.`);
			return cachedFiles;
		}
		const tfsItem = await getTfsDetail(Number(selectTfsItem.id));
		if (!tfsItem) return null;
		if (!generatePublishLog.value.data) {
			// 构造命令行
			let execArgs = new Array<string>();
			execArgs.push("history");
			execArgs.push(`/collection:${tfsItem.tfsServerUrl}`);
			execArgs.push(`${tfsItem.tfsSourcePath}`);
			execArgs.push("/noprompt");
			// [最近时间]按天数动态计算本次的日期范围，其余逻辑与[日期]一致
			if (selectTfsItem.selectModel === "日期" || selectTfsItem.selectModel === "最近时间") {
				let beginValue = String(selectTfsItem.selectValue[0].value || "");
				let endValue = String(selectTfsItem.selectValue[1]?.value || "");
				if (selectTfsItem.selectModel === "最近时间") {
					const recentRange = getRecentDaysDateRange(Number(beginValue));
					if (recentRange.length !== 2) {
						printInfoLog(`TFS[最近时间]的天数无效：${beginValue || "(空)"}，请填写正整数天数.`, "log-error");
						return null;
					}
					beginValue = recentRange[0];
					endValue = recentRange[1];
				}
				const bDate = new Date(beginValue);
				const beginDate = formatDate(bDate, "DYYYY-mm-ddTHH:MM:SS");
				let endDate = "";
				if (endValue) {
					const eDate = new Date(endValue);
					endDate = formatDate(eDate, "DYYYY-mm-ddTHH:MM:SS");
				}
				execArgs.push(`-V:${beginDate}~${endDate}`);
			}
			if (selectTfsItem.selectModel === "变更集") {
				const beginChangeSets = `C${selectTfsItem.selectValue[0].value}`;
				let endChangeSets = "";
				if (selectTfsItem.selectValue[1].value) {
					endChangeSets = `C${selectTfsItem.selectValue[1].value}`;
				}
				execArgs.push(`-V:${beginChangeSets}~${endChangeSets}`);
			}
			execArgs.push("-R");
			execArgs.push("-F:detailed");
			const execResult = await cmdInvoke("execute_local_command", {
				command: tfsItem.tfvcPath,
				args: execArgs,
			});
			if (execResult.code !== 0) {
				printInfoLog(`TFS命令执行失败：${execResult.data}`, "log-error");
				return null;
			}
			generatePublishLog.value.data = execResult.data;
		}

		// 生成发布日志
		if (generatePublishLog.value.isEnable) {
			let generateResult: DataResultType = {
				code: 1,
				msg: "success",
				data: null,
			};
			const dllResolveOptions = await getPublishLogResolveOptions();
			switch (generatePublishLog.value.type) {
				case "仅发布内容":
					generateResult = await outPublishContents(
						generatePublishLog.value.data,
						ctx.assemblyOutPath()
					);
					break;
				case "按日期":
					generateResult = await outPublishContentByDates(
						generatePublishLog.value.data,
						generatePublishLog.value.displayPublishField,
						ctx.assemblyOutPath(),
						true,
						dllResolveOptions
					);
					break;
				case "按用户":
					generateResult = await outPublishContentByUsers(
						generatePublishLog.value.data,
						generatePublishLog.value.displayPublishField,
						ctx.assemblyOutPath(),
						true,
						dllResolveOptions
					);
					break;
				default:
					generateResult = await outDetaultPublishContents(
						generatePublishLog.value.data,
						generatePublishLog.value.displayPublishField,
						ctx.assemblyOutPath(),
						true,
						dllResolveOptions
					);
					break;
			}
			if (generateResult.code === 0) {
				generatePublishLog.value.logs = generateResult.msg;
			}
		}

		// 筛选变更项
		const lines = generatePublishLog.value.data.split("\n");
		const tfsItems = lines
			.map((line: string) => getTfsChangedPath(line, tfsItem.tfsSourcePath))
			.filter((item: string) => item);
		const tfsDllFiles = await getDllFilesByChangedItems(tfsItems, {
			repositoryPath: tfsItem.tfsLocalPath,
			sourcePath: tfsItem.tfsSourcePath,
		});
		if (tfsDllFiles) {
			assemblyFileListCache.set(cacheKey, tfsDllFiles);
		}
		return tfsDllFiles;
	};

	// 构造Git命令
	const getGitDllFiles = async (selectGitItem: SelectGitType) => {
		const recentKey =
			selectGitItem.selectModel === "最近时间"
				? `:${getRecentDaysDateRange(Number(selectGitItem.selectValue[0].value)).join("~")}`
				: "";
		const cacheKey = `GIT:${selectGitItem.id}:${selectGitItem.selectModel}:${JSON.stringify(selectGitItem.selectValue)}${recentKey}`;
		const cachedFiles = assemblyFileListCache.get(cacheKey);
		if (cachedFiles) {
			printInfoLog(`  已复用本次运行的 Git 查询结果（${cachedFiles.length} 个文件），无需再次查询.`);
			return cachedFiles;
		}
		const gitItem = await getGitDetail(Number(selectGitItem.id));
		if (!gitItem) return null;
		if (!generatePublishLog.value.data) {
			// Git命令执行
			let execArgs = new Array<string | null>();
			execArgs.push("log");
			execArgs.push("--pretty=format:%H|%an|%ae|%ad|%s");
			execArgs.push("--name-status");
			// [最近时间]按天数动态计算本次的日期范围，其余逻辑与[日期]一致
			if (selectGitItem.selectModel === "日期" || selectGitItem.selectModel === "最近时间") {
				let beginValue = String(selectGitItem.selectValue[0].value || "");
				let endValue = String(selectGitItem.selectValue[1]?.value || "");
				if (selectGitItem.selectModel === "最近时间") {
					const recentRange = getRecentDaysDateRange(Number(beginValue));
					if (recentRange.length !== 2) {
						printInfoLog(`Git[最近时间]的天数无效：${beginValue || "(空)"}，请填写正整数天数.`, "log-error");
						return null;
					}
					beginValue = recentRange[0];
					endValue = recentRange[1];
				}
				const bDate = new Date(beginValue);
				const beginDate = formatDate(bDate, "DYYYY-mm-ddTHH:MM:SS");
				let endDate = "";
				if (endValue) {
					const eDate = new Date(endValue);
					endDate = formatDate(eDate, "DYYYY-mm-ddTHH:MM:SS");
				}
				execArgs.push(`--since=${beginDate}`);
				execArgs.push(`--until=${endDate}`);
			}
			// 用 isCommitSelectModel 兼容界面值「变更集」与历史值 "commit"
			if (isCommitSelectModel(selectGitItem.selectModel)) {
				const startSha = selectGitItem.selectValue[0].value;
				const endSha = selectGitItem.selectValue[1].value;
				if (startSha && !endSha) {
					execArgs.push(`${startSha}..HEAD`);
				} else if (startSha && endSha) {
					execArgs.push(`${startSha}^..${endSha}`);
				} else if (!startSha && endSha) {
					execArgs.push(endSha);
				}
			}
			execArgs.push(gitItem.branchName);
			const execResult = await cmdInvoke("execute_local_command_with_working_dir", {
				command: gitItem.gitPath,
				args: execArgs,
				workingDir: gitItem.gitRepository,
			});
			if (execResult.code !== 0) {
				printInfoLog(`Git命令执行失败：${execResult.data}`, "log-error");
				return null;
			}
			generatePublishLog.value.data = execResult.data;
		}

		// 生成发布日志
		if (generatePublishLog.value.isEnable) {
			let generateResult: DataResultType = {
				code: 1,
				msg: "success",
				data: null,
			};
			const dllResolveOptions = await getPublishLogResolveOptions();
			switch (generatePublishLog.value.type) {
				case "仅发布内容":
					generateResult = await outPublishContents(
						generatePublishLog.value.data,
						ctx.assemblyOutPath()
					);
					break;
				case "按日期":
					generateResult = await outPublishContentByDates(
						generatePublishLog.value.data,
						generatePublishLog.value.displayPublishField,
						ctx.assemblyOutPath(),
						true,
						dllResolveOptions
					);
					break;
				case "按用户":
					generateResult = await outPublishContentByUsers(
						generatePublishLog.value.data,
						generatePublishLog.value.displayPublishField,
						ctx.assemblyOutPath(),
						true,
						dllResolveOptions
					);
					break;
				default:
					generateResult = await outDetaultPublishContents(
						generatePublishLog.value.data,
						generatePublishLog.value.displayPublishField,
						ctx.assemblyOutPath(),
						true,
						dllResolveOptions
					);
					break;
			}
			if (generateResult.code === 0) {
				generatePublishLog.value.logs = generateResult.msg;
			}
		}

		// 筛选变更项
		const lines = generatePublishLog.value.data.split("\n");
		let gitItems: string[] = [];
		let currentLineIndex = 0;
		while (currentLineIndex < lines.length) {
			const line = lines[currentLineIndex];
			if (/^[a-f0-9]{40}\|/.test(line)) {
				// 提交信息行，跳过
			} else if (line.trim() && !line.startsWith("commit") && !line.startsWith("Author:") && !line.startsWith("Date:")) {
				const fileChangeMatch = line.match(/^([MAD])\s+(.+)$/);
				if (fileChangeMatch) {
					gitItems.push(fileChangeMatch[2].trim());
				}
			}
			currentLineIndex++;
		}
		const gitDllFiles = await getDllFilesByChangedItems(gitItems, {
			repositoryPath: gitItem.gitRepository,
		});
		if (gitDllFiles) {
			assemblyFileListCache.set(cacheKey, gitDllFiles);
		}
		return gitDllFiles;
	};

	const getPublishLogResolveOptions = async (): Promise<DllResolveOptions> => {
		const appconfigData = ctx.appconfigData();
		if (!appconfigData.dllModeValue) return {};
		if (appconfigData.dllMode === "TFS") {
			const selectTfsItem = JSON.parse(appconfigData.dllModeValue) as SelectTfsType;
			const tfsItem = await getTfsDetail(Number(selectTfsItem.id));
			return {
				repositoryPath: tfsItem?.tfsLocalPath,
				sourcePath: tfsItem?.tfsSourcePath,
			};
		}
		if (appconfigData.dllMode === "Git") {
			const selectGitItem = JSON.parse(appconfigData.dllModeValue) as SelectGitType;
			const gitItem = await getGitDetail(Number(selectGitItem.id));
			return { repositoryPath: gitItem?.gitRepository };
		}
		return {};
	};

	// 复制应用程序集[文件]（WebApiHost/ScheduleServer/WebClient/SpcMonitor）
	const copyAssemblyFile = async (
		appTypeName: "WebApiHost" | "ScheduleServer" | "WebClient" | "SpcMonitor",
		projectOutPath: string,
		appConfig:
			| WebApiHostConfigType
			| ScheduleServerConfigType
			| WebClientConfigType
			| SpcMonitorConfigType
	) => {
		if (checkStop()) return false;
		printInfoLog(`正在获取 ${appTypeName} 程序集.`);
		const stepStartTime = Date.now();

		// 删除项目输出目录
		let outPath = `${projectOutPath}/${appTypeName}`;
		const projectOutPathExists = await cmdInvoke("exists", { path: outPath });
		if (projectOutPathExists.code === 0) {
			const delResult = await cmdInvoke("delete_paths", { paths: [outPath] });
			if (delResult.code !== 0) {
				printInfoLog(`删除输出目录失败：${outPath}，${delResult.data}`, "log-error");
			}
		}
		let createPathResult = await createDir(outPath);
		if (!createPathResult) {
			printInfoLog(`创建目录失败：${outPath}`, "log-error");
			return false;
		}
		if (!appConfig.clientPath) {
			printInfoLog(`${appTypeName} 的[客户端生成路径]未配置，请检查.`, "log-error");
			return false;
		}
		printInfoLog(`  输出目录：${outPath}`);
		try {
			let copyResult = { code: 0, msg: "success", data: null };
			const appconfigData = ctx.appconfigData();
			printInfoLog(`  源路径（客户端生成路径）：${removeSlash(appConfig.clientPath)}`);
			if (appconfigData.dllMode == "TFS") {
				if (!appconfigData.dllModeValue) {
					printInfoLog(`未配置TFS获取程序集的相关信息，请检查.`, "log-error");
					return false;
				}
				const selectTfsItem = JSON.parse(appconfigData.dllModeValue) as SelectTfsType;
				printInfoLog(`  获取方式[TFS]：获取 TFS 变更文件清单（tf history，同一配置本次运行只查询一次）...`);
				printInfoLog(`  获取范围：${getFetchRangeText()}`);
				const tfsDllFiles = await getTfsDllFiles(selectTfsItem);
				if (!tfsDllFiles || tfsDllFiles.length < 1) return false;
				printInfoLog(`  TFS 变更文件清单共 ${tfsDllFiles.length} 个，开始逐个复制.`);
				const tfsProgressIndex = printInfoLog(`  复制文件：`);
				for (let o = 0; o < tfsDllFiles.length; o++) {
					if (checkStop()) return false;
					const tfsDllFile = tfsDllFiles[o];
					const clientPath = removeSlash(appConfig.clientPath);
					copyResult = await cmdInvoke("copy_path", {
						source: `${clientPath}/${tfsDllFile}`,
						destination: `${removeSlash(outPath)}/${tfsDllFile}`,
						...getRetryArgs("copy"),
					});
					if (copyResult.code !== 0) {
						printInfoLog(`  复制失败：${tfsDllFile}`, "log-error");
						break;
					}
					updateLogProgress(tfsProgressIndex, "", o + 1, tfsDllFiles.length);
				}
			} else if (appconfigData.dllMode == "Git") {
				if (!appconfigData.dllModeValue) {
					printInfoLog(`未配置Git获取程序集的相关信息，请检查.`, "log-error");
					return false;
				}
				const selectGitItem = JSON.parse(appconfigData.dllModeValue) as SelectGitType;
				printInfoLog(`  获取方式[Git]：获取 Git 变更文件清单（同一配置本次运行只查询一次）...`);
				printInfoLog(`  获取范围：${getFetchRangeText()}`);
				const gitDllFiles = await getGitDllFiles(selectGitItem);
				if (!gitDllFiles || gitDllFiles.length < 1) return false;
				printInfoLog(`  Git 变更文件清单共 ${gitDllFiles.length} 个，开始逐个复制.`);
				const gitProgressIndex = printInfoLog(`  复制文件：`);
				for (let o = 0; o < gitDllFiles.length; o++) {
					if (checkStop()) return false;
					const gitDllFile = gitDllFiles[o];
					const clientPath = removeSlash(appConfig.clientPath);
					copyResult = await cmdInvoke("copy_path", {
						source: `${clientPath}/${gitDllFile}`,
						destination: `${removeSlash(outPath)}/${gitDllFile}`,
						...getRetryArgs("copy"),
					});
					if (copyResult.code !== 0) {
						printInfoLog(`  复制失败：${gitDllFile}`, "log-error");
						break;
					}
					updateLogProgress(gitProgressIndex, "", o + 1, gitDllFiles.length);
				}
			} else if (appconfigData.dllMode == "DLL名称") {
				const patterns = getDllModePatterns();
				if (!patterns) {
					printInfoLog(`未配置DLL名称获取程序集的相关信息，请检查.`, "log-error");
					return false;
				}
				printInfoLog(`  获取方式[DLL名称]：按名称模式匹配复制（${patterns.replace(/\n|、/g, "、")}）...`);
				copyResult = await cmdInvoke("copy_dll_files_by_name", {
					source: appConfig.clientPath,
					destination: outPath,
					delDestination: true,
					patterns: patterns,
				});
			} else {
				let dllModeDateRange = getDllModeDateRange();
				if (dllModeDateRange.length < 1) {
					printInfoLog(`  获取方式[全部]：复制源目录下全部 DLL 文件...`);
					copyResult = await cmdInvoke("copy_dll_files", {
						source: appConfig.clientPath,
						destination: outPath,
						delDestination: true,
					});
				} else {
					printInfoLog(`  获取方式[${appconfigData.dllMode}]：按修改时间筛选复制（${dllModeDateRange[0]} ~ ${dllModeDateRange[1]}）...`);
					copyResult = await cmdInvoke("copy_dll_files_by_time", {
						source: appConfig.clientPath,
						destination: outPath,
						delDestination: true,
						startTime: dllModeDateRange[0],
						endTime: dllModeDateRange[1],
					});
				}
			}
			if (copyResult.code !== 0) {
				printInfoLog(`获取程序集 ${appTypeName} 失败：${copyResult.data}`, "log-error");
				return false;
			}
		} catch (error) {
			printInfoLog(`获取程序集 ${appTypeName} 出错：${JSON.stringify(error)}`, "log-error");
			return false;
		}
		// 验证是否为空文件夹
		const dirEmptyResult = await cmdInvoke("is_dir_empty", { path: outPath });
		if (dirEmptyResult.code !== 0) {
			printInfoLog(`输出路径为空：${outPath}.`, "log-warning");
		} else {
			printInfoLog(`获取程序集 ${appTypeName} 成功，耗时 ${formatElapsed(Date.now() - stepStartTime)}.`, "log-success");
		}
		return true;
	};

	// [新]复制Wpf应用程序集[文件]
	const newCopyWpfAssemblyFile = async (projectOutPath: string, appConfig: WpfClientConfigType) => {
		printInfoLog(`正在获取 ${MODULE_NAMES.wpfClient} 程序集.`);
		const stepStartTime = Date.now();
		const appconfigData = ctx.appconfigData();

		let outPath = `${projectOutPath}/${MODULE_NAMES.wpfClient}`;
		printInfoLog(`  输出目录：${outPath}`);
		const projectOutPathExists = await cmdInvoke("exists", { path: outPath });
		if (projectOutPathExists.code === 0) {
			const delResult = await cmdInvoke("delete_paths", { paths: [outPath] });
			if (delResult.code !== 0) {
				printInfoLog(`删除输出目录失败：${outPath}，${delResult.data}`, "log-error");
			}
		}
		let createPathResult = await createDir(outPath);
		if (!createPathResult) {
			printInfoLog(`创建目录失败：${outPath}`, "log-error");
			return false;
		}
		if (!appConfig.clientPath) {
			printInfoLog(`${MODULE_NAMES.wpfClient} 的[客户端生成路径]未配置，请检查.`, "log-error");
			return false;
		}
		printInfoLog(`  源路径（客户端生成路径）：${removeSlash(appConfig.clientPath)}`);
		if (!appConfig.generateDirJson) {
			printInfoLog(`${MODULE_NAMES.wpfClient} 未选择[生成的目录]，请检查.`, "log-error");
			return false;
		}

		try {
			let dllModeDateRange = getDllModeDateRange();
			// 1.[生成目录]
			let generateDirArr = JSON.parse(appConfig.generateDirJson);
			printInfoLog(`  生成目录（${generateDirArr.length}个）：${generateDirArr.join("、")}`);
			for (let i = 0; i < generateDirArr.length; i++) {
				const generateDir = generateDirArr[i];
				// 验证目录是否存在
				const dirPath = `${removeSlash(appConfig.clientPath)}/${generateDir}`;
				if (generateDir == "Plugins" || generateDir == "Lib") {
					printInfoLog(`  [${generateDir}]：清空后从客户端生成路径重新收集 DLL（${generateDir == "Plugins" ? "copy_sie_dlls：仅 SIE. 开头的 DLL" : "copy_non_sie_dlls：非 SIE. 开头的 DLL"}）...`);
					await cmdInvoke("delete_paths", { paths: [dirPath] });
					await createDir(dirPath);
					let cmdName = generateDir == "Plugins" ? "copy_sie_dlls" : "copy_non_sie_dlls";
					let copyDllFileResult = await cmdInvoke(cmdName, {
						srcDir: removeSlash(appConfig.clientPath),
						destDir: dirPath,
					});
					if (copyDllFileResult.code !== 0) {
						printInfoLog(`${generateDir}目录不存在，请检查路径或编译项目试试.`, "log-error");
						return false;
					}
					printInfoLog(`  [${generateDir}]：DLL 重新收集完成.`);
				}
				const dirPathExists = await cmdInvoke("exists", { path: dirPath });
				if (dirPathExists.code !== 0) {
					printInfoLog(`${generateDir}目录不存在，请检查路径或编译项目试试.`, "log-error");
					return false;
				}

				// 复制目录
				let copyResult = { code: 0, msg: "success", data: null };
				const toGenerateDir = `${removeSlash(outPath)}/${generateDir}`;
				await createDir(toGenerateDir);

				if (appconfigData.dllMode == "TFS") {
					if (!appconfigData.dllModeValue) {
						printInfoLog(`未配置TFS获取程序集的相关信息，请检查.`, "log-error");
						return false;
					}
					const selectTfsItem = JSON.parse(appconfigData.dllModeValue) as SelectTfsType;
					printInfoLog(`  [${generateDir}]：获取 TFS 变更文件清单（同一配置本次运行只查询一次）...`);
					const tfsDllFiles = await getTfsDllFiles(selectTfsItem);
					if (!tfsDllFiles || tfsDllFiles.length < 1) return false;
					printInfoLog(`  [${generateDir}]：变更文件清单共 ${tfsDllFiles.length} 个，开始逐个复制.`);
					const dirProgressIndex = printInfoLog(`  [${generateDir}] 复制文件：`);

					for (let j = 0; j < tfsDllFiles.length; j++) {
						if (checkStop()) return false;
						const tfsDllFile = tfsDllFiles[j];
						const clientPath = removeSlash(dirPath);
						copyResult = await cmdInvoke("copy_path", {
							source: `${clientPath}/${tfsDllFile}`,
							destination: `${toGenerateDir}/${tfsDllFile}`,
							...getRetryArgs("copy"),
						});
						if (copyResult.code !== 0) {
							printInfoLog(`  复制失败：${tfsDllFile}`, "log-error");
							break;
						}
						updateLogProgress(dirProgressIndex, "", j + 1, tfsDllFiles.length);
					}
				} else if (appconfigData.dllMode == "DLL名称") {
					const patterns = getDllModePatterns();
					if (!patterns) {
						printInfoLog(`未配置DLL名称获取程序集的相关信息，请检查.`, "log-error");
						return false;
					}
					printInfoLog(`  [${generateDir}]：按DLL名称模式匹配复制...`);
					copyResult = await cmdInvoke("copy_dll_files_by_name", {
						source: dirPath,
						destination: `${outPath}/${generateDir}`,
						delDestination: true,
						patterns: patterns,
					});
				} else {
					if (dllModeDateRange.length < 1) {
						printInfoLog(`  [${generateDir}]：整目录复制...`);
						copyResult = await cmdInvoke("copy_path", {
							source: dirPath,
							destination: `${outPath}/${generateDir}`,
							...getRetryArgs("copy"),
						});
					} else {
						printInfoLog(`  [${generateDir}]：按修改时间筛选复制（${dllModeDateRange[0]} ~ ${dllModeDateRange[1]}）...`);
						copyResult = await cmdInvoke("copy_path_by_time", {
							source: dirPath,
							destination: `${outPath}/${generateDir}`,
							startTime: dllModeDateRange[0],
							endTime: dllModeDateRange[1],
						});
					}
				}

				if (copyResult.code !== 0) {
					printInfoLog(`复制[${generateDir}]失败：${copyResult.data}`, "log-error");
					return false;
				}

				// 验证文件是否存在
				const isDirEmpty = await cmdInvoke("is_dir_empty", { path: `${outPath}/${generateDir}` });
				if (isDirEmpty.code !== 0) {
					printInfoLog(`输出路径为空：${`${outPath}/${generateDir}`}.`, "log-warning");
				}
			}

			// 2.[打包(压缩)文件]
			if (appConfig.isCompress == 1) {
				if (!appConfig.compressFileJson) {
					printInfoLog(`${MODULE_NAMES.wpfClient} 未选择要打包(压缩)文件，请检查.`, "log-error");
					return false;
				}

				let compressFileArr = JSON.parse(appConfig.compressFileJson);
				printInfoLog(`  打包(压缩)文件（${compressFileArr.length}个）：${compressFileArr.join("、")}`);
				if (compressFileArr.includes("Plugins.zip")) {
					printInfoLog(`  正在打包[Plugins.zip]...`);
					const pluginsPath = `${removeSlash(appConfig.clientPath)}/Plugins`;
					const pluginsZipResult = await cmdInvoke("zip_dir", {
						srcDir: pluginsPath,
						dstFile: `${outPath}/Plugins.zip`,
					});
					if (pluginsZipResult.code !== 0) {
						printInfoLog(`压缩[Plugins.zip]失败：${pluginsZipResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Plugins.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Lib.zip")) {
					printInfoLog(`  正在打包[Lib.zip]...`);
					const libPath = `${removeSlash(appConfig.clientPath)}/Lib`;
					const libZipResult = await cmdInvoke("zip_dir", {
						srcDir: libPath,
						dstFile: `${outPath}/Lib.zip`,
					});
					if (libZipResult.code !== 0) {
						printInfoLog(`压缩[Lib.zip]失败：${libZipResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Lib.zip] 打包完成.`);
				}

				if (compressFileArr.includes("runtimes.zip")) {
					printInfoLog(`  正在打包[runtimes.zip]...`);
					const tempRuntimesPath = `${removeSlash(appConfig.clientPath)}/tmp_runtimes/runtimes`;
					await cmdInvoke("delete_paths", { paths: [tempRuntimesPath] });
					await createDir(tempRuntimesPath);

					const addRuntimesPath = `${removeSlash(appConfig.clientPath)}/runtimes`;
					await cmdInvoke("copy_path", {
						source: addRuntimesPath,
						destination: tempRuntimesPath,
						...getRetryArgs("copy"),
					});

					const zipRuntimesResult = await cmdInvoke("zip_dir", {
						srcDir: `${removeSlash(appConfig.clientPath)}/tmp_runtimes`,
						dstFile: `${outPath}/runtimes.zip`,
					});
					if (zipRuntimesResult.code !== 0) {
						printInfoLog(`压缩[runtimes.zip]失败：${zipRuntimesResult.data}.`, "log-error");
						return false;
					}

					await cmdInvoke("delete_paths", { paths: [tempRuntimesPath] });
					printInfoLog(`  [runtimes.zip] 打包完成.`);
				}

				if (compressFileArr.includes("AddIns.zip")) {
					printInfoLog(`  正在打包[AddIns.zip]...`);
					const addInsPath = `${removeSlash(appConfig.clientPath)}/AddIns`;
					const compresseAddInsResult = await cmdInvoke("compress_zip", {
						filePaths: [addInsPath],
						dstFile: `${outPath}/AddIns.zip`,
					});
					if (compresseAddInsResult.code !== 0) {
						printInfoLog(`压缩[AddIns.zip]失败：${compresseAddInsResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [AddIns.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Localization.zip")) {
					printInfoLog(`  正在打包[Localization.zip]...`);
					const localizationPath = `${removeSlash(appConfig.clientPath)}/Localization`;
					const compresseResult = await cmdInvoke("compress_zip", {
						filePaths: [localizationPath],
						dstFile: `${outPath}/Localization.zip`,
					});
					if (compresseResult.code !== 0) {
						printInfoLog(`压缩[Localization.zip]失败：${compresseResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Localization.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Templates.zip")) {
					printInfoLog(`  正在打包[Templates.zip]...`);
					const templatesPath = `${removeSlash(appConfig.clientPath)}/Templates`;
					const compresseResult = await cmdInvoke("compress_zip", {
						filePaths: [templatesPath],
						dstFile: `${outPath}/Templates.zip`,
					});
					if (compresseResult.code !== 0) {
						printInfoLog(`压缩[Templates.zip]失败：${compresseResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Templates.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Config.zip")) {
					printInfoLog(`  正在打包[Config.zip]...`);
					const configZipResult = await packConfigZip(appConfig, outPath);
					if (!configZipResult) return false;
					printInfoLog(`  [Config.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Main.zip")) {
					printInfoLog(`  正在打包[Main.zip]...`);
					const mainZipResult = await packMainZip(appConfig, outPath);
					if (!mainZipResult) return false;
					printInfoLog(`  [Main.zip] 打包完成.`);
				}
			}
		} catch (error) {
			printInfoLog(
				`获取程序集 ${MODULE_NAMES.wpfClient} 出错：${JSON.stringify(error)}`,
				"log-error"
			);
			return false;
		}
		printInfoLog(`获取程序集 ${MODULE_NAMES.wpfClient} 成功，耗时 ${formatElapsed(Date.now() - stepStartTime)}.`, "log-success");
		return true;
	};

	// 复制Wpf应用程序集[文件]（旧版）
	const copyWpfAssemblyFile = async (projectOutPath: string, appConfig: WpfClientConfigType) => {
		printInfoLog(`正在获取 ${MODULE_NAMES.wpfClient} 程序集.`);
		const stepStartTime = Date.now();
		const appconfigData = ctx.appconfigData();

		let outPath = `${projectOutPath}/${MODULE_NAMES.wpfClient}`;
		printInfoLog(`  输出目录：${outPath}`);
		const projectOutPathExists = await cmdInvoke("exists", { path: outPath });
		if (projectOutPathExists.code === 0) {
			const delResult = await cmdInvoke("delete_paths", { paths: [outPath] });
			if (delResult.code !== 0) {
				printInfoLog(`删除输出目录失败：${outPath}，${delResult.data}`, "log-error");
			}
		}
		let createPathResult = await createDir(outPath);
		if (!createPathResult) {
			printInfoLog(`创建目录失败：${outPath}`, "log-error");
			return false;
		}
		if (!appConfig.clientPath) {
			printInfoLog(`${MODULE_NAMES.wpfClient} 的[客户端生成路径]未配置，请检查.`, "log-error");
			return false;
		}
		printInfoLog(`  源路径（客户端生成路径）：${removeSlash(appConfig.clientPath)}`);
		if (!appConfig.generateDirJson) {
			printInfoLog(`${MODULE_NAMES.wpfClient} 未选择[生成的目录]，请检查.`, "log-error");
			return false;
		}

		try {
			let dllModeDateRange = getDllModeDateRange();
			// 1.[生成目录]
			let generateDirArr = JSON.parse(appConfig.generateDirJson);
			printInfoLog(`  生成目录（${generateDirArr.length}个）：${generateDirArr.join("、")}`);
			for (let i = 0; i < generateDirArr.length; i++) {
				const generateDir = generateDirArr[i];
				const dirPath = `${removeSlash(appConfig.clientPath)}/${generateDir}`;
				const dirPathExists = await cmdInvoke("exists", { path: dirPath });
				if (dirPathExists.code !== 0) {
					printInfoLog(`${generateDir}目录不存在，请检查路径或编译项目试试.`, "log-error");
					return false;
				}

				let copyResult = { code: 0, msg: "success", data: null };
				const toGenerateDir = `${removeSlash(outPath)}/${generateDir}`;
				await createDir(toGenerateDir);

				if (appconfigData.dllMode == "TFS") {
					if (!appconfigData.dllModeValue) {
						printInfoLog(`未配置TFS获取程序集的相关信息，请检查.`, "log-error");
						return false;
					}
					const selectTfsItem = JSON.parse(appconfigData.dllModeValue) as SelectTfsType;
					printInfoLog(`  [${generateDir}]：获取 TFS 变更文件清单（同一配置本次运行只查询一次）...`);
					const tfsDllFiles = await getTfsDllFiles(selectTfsItem);
					if (!tfsDllFiles || tfsDllFiles.length < 1) return false;
					printInfoLog(`  [${generateDir}]：变更文件清单共 ${tfsDllFiles.length} 个，开始逐个复制.`);
					const dirProgressIndex = printInfoLog(`  [${generateDir}] 复制文件：`);

					for (let j = 0; j < tfsDllFiles.length; j++) {
						if (checkStop()) return false;
						const tfsDllFile = tfsDllFiles[j];
						const clientPath = removeSlash(dirPath);
						copyResult = await cmdInvoke("copy_path", {
							source: `${clientPath}/${tfsDllFile}`,
							destination: `${toGenerateDir}/${tfsDllFile}`,
							...getRetryArgs("copy"),
						});
						if (copyResult.code !== 0) {
							printInfoLog(`  复制失败：${tfsDllFile}`, "log-error");
							break;
						}
						updateLogProgress(dirProgressIndex, "", j + 1, tfsDllFiles.length);
					}
				} else if (appconfigData.dllMode == "DLL名称") {
					const patterns = getDllModePatterns();
					if (!patterns) {
						printInfoLog(`未配置DLL名称获取程序集的相关信息，请检查.`, "log-error");
						return false;
					}
					printInfoLog(`  [${generateDir}]：按DLL名称模式匹配复制...`);
					copyResult = await cmdInvoke("copy_dll_files_by_name", {
						source: dirPath,
						destination: `${outPath}/${generateDir}`,
						delDestination: true,
						patterns: patterns,
					});
				} else {
					if (dllModeDateRange.length < 1) {
						printInfoLog(`  [${generateDir}]：整目录复制...`);
						copyResult = await cmdInvoke("copy_path", {
							source: dirPath,
							destination: `${outPath}/${generateDir}`,
							...getRetryArgs("copy"),
						});
					} else {
						printInfoLog(`  [${generateDir}]：按修改时间筛选复制（${dllModeDateRange[0]} ~ ${dllModeDateRange[1]}）...`);
						copyResult = await cmdInvoke("copy_path_by_time", {
							source: dirPath,
							destination: `${outPath}/${generateDir}`,
							startTime: dllModeDateRange[0],
							endTime: dllModeDateRange[1],
						});
					}
				}

				if (copyResult.code !== 0) {
					printInfoLog(`复制[${generateDir}]失败：${copyResult.data}`, "log-error");
					return false;
				}

				const isDirEmpty = await cmdInvoke("is_dir_empty", { path: `${outPath}/${generateDir}` });
				if (isDirEmpty.code !== 0) {
					printInfoLog(`输出路径为空：${`${outPath}/${generateDir}`}.`, "log-warning");
				}
			}

			// 2.[打包(压缩)文件]
			if (appConfig.isCompress == 1) {
				if (!appConfig.compressFileJson) {
					printInfoLog(`${MODULE_NAMES.wpfClient} 未选择要打包(压缩)文件，请检查.`, "log-error");
					return false;
				}
				let compressFileArr = JSON.parse(appConfig.compressFileJson);
				printInfoLog(`  打包(压缩)文件（${compressFileArr.length}个）：${compressFileArr.join("、")}`);
				if (compressFileArr.includes("Plugins.zip")) {
					printInfoLog(`  正在打包[Plugins.zip]...（Domain + UI）`);
					const domainPath = `${removeSlash(appConfig.clientPath)}/Domain`;
					const uiPath = `${removeSlash(appConfig.clientPath)}/UI`;
					const compressePluginsResult = await cmdInvoke("compress_zip", {
						filePaths: [domainPath, uiPath],
						dstFile: `${outPath}/Plugins.zip`,
					});
					if (compressePluginsResult.code !== 0) {
						printInfoLog(`压缩[Plugins.zip]失败：${compressePluginsResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Plugins.zip] 打包完成.`);
				}

				if (compressFileArr.includes("AddIns.zip")) {
					printInfoLog(`  正在打包[AddIns.zip]...`);
					const addInsPath = `${removeSlash(appConfig.clientPath)}/AddIns`;
					const compresseAddInsResult = await cmdInvoke("compress_zip", {
						filePaths: [addInsPath],
						dstFile: `${outPath}/AddIns.zip`,
					});
					if (compresseAddInsResult.code !== 0) {
						printInfoLog(`压缩[AddIns.zip]失败：${compresseAddInsResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [AddIns.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Lib.zip")) {
					printInfoLog(`  正在打包[Lib.zip]...`);
					const libPath = `${removeSlash(appConfig.clientPath)}/Lib`;
					const compresseResult = await cmdInvoke("compress_zip", {
						filePaths: [libPath],
						dstFile: `${outPath}/Lib.zip`,
					});
					if (compresseResult.code !== 0) {
						printInfoLog(`压缩[Lib.zip]失败：${compresseResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Lib.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Localization.zip")) {
					printInfoLog(`  正在打包[Localization.zip]...`);
					const localizationPath = `${removeSlash(appConfig.clientPath)}/Localization`;
					const compresseResult = await cmdInvoke("compress_zip", {
						filePaths: [localizationPath],
						dstFile: `${outPath}/Localization.zip`,
					});
					if (compresseResult.code !== 0) {
						printInfoLog(`压缩[Localization.zip]失败：${compresseResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Localization.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Templates.zip")) {
					printInfoLog(`  正在打包[Templates.zip]...`);
					const templatesPath = `${removeSlash(appConfig.clientPath)}/Templates`;
					const compresseResult = await cmdInvoke("compress_zip", {
						filePaths: [templatesPath],
						dstFile: `${outPath}/Templates.zip`,
					});
					if (compresseResult.code !== 0) {
						printInfoLog(`压缩[Templates.zip]失败：${compresseResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Templates.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Config.zip")) {
					printInfoLog(`  正在打包[Config.zip]...（log4net.config + SIE.MOM.exe.config + appsettings.json）`);
					// 旧版：log4net.config、SIE.MOM.exe.config、appsettings.json
					const log4netConfigFile = `${removeSlash(appConfig.clientPath)}/log4net.config`;
					const log4netConfigFileExists = await cmdInvoke("exists", { path: log4netConfigFile });
					if (log4netConfigFileExists.code !== 0) {
						printInfoLog("未找到log4net.config文件，请检查路径或编译项目试试.", "log-error");
						return false;
					}

					const sieMomExeConfigFile = `${removeSlash(appConfig.clientPath)}/SIE.MOM.exe.config`;
					const sieMomExeConfigFileExists = await cmdInvoke("exists", { path: sieMomExeConfigFile });
					if (sieMomExeConfigFileExists.code !== 0) {
						printInfoLog("未找到SIE.MOM.exe.config文件，请检查路径或编译项目试试.", "log-error");
						return false;
					}

					const appsettingsFile = `${removeSlash(appConfig.clientPath)}/appsettings.json`;
					const appsettingsFileExists = await cmdInvoke("exists", { path: appsettingsFile });
					if (appsettingsFileExists.code !== 0) {
						printInfoLog("未找到appsettings.json文件，请检查路径或编译项目试试.", "log-error");
						return false;
					}

					const compresseConfigResult = await cmdInvoke("compress_zip", {
						filePaths: [log4netConfigFile, sieMomExeConfigFile, appsettingsFile],
						dstFile: `${outPath}/Config.zip`,
					});
					if (compresseConfigResult.code !== 0) {
						printInfoLog(`压缩[Config.zip]失败：${compresseConfigResult.data}.`, "log-error");
						return false;
					}
					printInfoLog(`  [Config.zip] 打包完成.`);
				}

				if (compressFileArr.includes("Main.zip")) {
					printInfoLog(`  正在打包[Main.zip]...`);
					const mainZipResult = await packMainZip(appConfig, outPath);
					if (!mainZipResult) return false;
					printInfoLog(`  [Main.zip] 打包完成.`);
				}
			}
		} catch (error) {
			printInfoLog(
				`获取程序集 ${MODULE_NAMES.wpfClient} 出错：${JSON.stringify(error)}`,
				"log-error"
			);
			return false;
		}
		printInfoLog(`获取程序集 ${MODULE_NAMES.wpfClient} 成功，耗时 ${formatElapsed(Date.now() - stepStartTime)}.`, "log-success");
		return true;
	};

	// 打包 Config.zip（新版：log4net.config、SIE.MOM.deps.json、SIE.MOM.runtimeconfig.json、RazorTemplate.txt、appsettings.json）
	const packConfigZip = async (appConfig: WpfClientConfigType, outPath: string) => {
		const clientBase = removeSlash(String(appConfig.clientPath));
		const requiredFiles = [
			{ path: `${clientBase}/log4net.config`, name: "log4net.config" },
			{ path: `${clientBase}/SIE.MOM.deps.json`, name: "SIE.MOM.deps.json" },
			{ path: `${clientBase}/SIE.MOM.runtimeconfig.json`, name: "SIE.MOM.runtimeconfig.json" },
			{ path: `${clientBase}/RazorTemplate.txt`, name: "RazorTemplate.txt" },
			{ path: `${clientBase}/appsettings.json`, name: "appsettings.json" },
		];
		for (const file of requiredFiles) {
			const existsResult = await cmdInvoke("exists", { path: file.path });
			if (existsResult.code !== 0) {
				printInfoLog(`未找到${file.name}文件，请检查路径或编译项目试试.`, "log-error");
				return false;
			}
		}
		const compresseConfigResult = await cmdInvoke("compress_zip", {
			filePaths: requiredFiles.map((f) => f.path),
			dstFile: `${outPath}/Config.zip`,
		});
		if (compresseConfigResult.code !== 0) {
			printInfoLog(`压缩[Config.zip]失败：${compresseConfigResult.data}.`, "log-error");
			return false;
		}
		return true;
	};

	// 打包 Main.zip（SIE.dll、SIE.MOM.exe、SIE.Wpf.dll）
	const packMainZip = async (appConfig: WpfClientConfigType, outPath: string) => {
		const clientBase = removeSlash(String(appConfig.clientPath));
		const requiredFiles = [
			{ path: `${clientBase}/SIE.dll`, name: "SIE.dll" },
			{ path: `${clientBase}/SIE.MOM.exe`, name: "SIE.MOM.exe" },
			{ path: `${clientBase}/SIE.Wpf.dll`, name: "SIE.Wpf.dll" },
		];
		for (const file of requiredFiles) {
			const existsResult = await cmdInvoke("exists", { path: file.path });
			if (existsResult.code !== 0) {
				printInfoLog(`未找到${file.name}文件，请检查路径或编译项目试试.`, "log-error");
				return false;
			}
		}
		const compresseMainResult = await cmdInvoke("compress_zip", {
			filePaths: requiredFiles.map((f) => f.path),
			dstFile: `${outPath}/Main.zip`,
		});
		if (compresseMainResult.code !== 0) {
			printInfoLog(`压缩[Main.zip]失败：${compresseMainResult.data}.`, "log-error");
			return false;
		}
		return true;
	};

	// 获取应用程序集（入口）
	const getApplicationAssemblys = async (isOpenDir: boolean = false) => {
		resetStopState();
		const appconfigData = ctx.appconfigData();
		const projectOutPath = ctx.assemblyOutPath();
		let isSuccess = true;
		const overallStartTime = Date.now();
		// 每次运行重置 TFS/Git 查询缓存（同一配置本次运行只查询一次）
		assemblyFileListCache.clear();
		printInfoLog("");
		// 参与模块清单
		const includedModules = [
			appconfigData.configItems.webApiHost.clientPath ? MODULE_NAMES.webApiHost : "",
			appconfigData.configItems.scheduleServer.clientPath ? MODULE_NAMES.scheduleServer : "",
			appconfigData.configItems.webClient.clientPath ? MODULE_NAMES.webClient : "",
			appconfigData.configItems.spcMonitor.clientPath ? MODULE_NAMES.spcMonitor : "",
			appconfigData.configItems.wpfClient.clientPath ? MODULE_NAMES.wpfClient : "",
		].filter(Boolean);
		printInfoLog(`开始获取程序集，获取方式：${appconfigData.dllMode}，获取范围：${getFetchRangeText()}，输出路径：${projectOutPath}`);
		printInfoLog(`参与模块（${includedModules.length}个）：${includedModules.join("、")}`);
		// 逐模块获取；任一模块后请求停止则立即中止，不再执行后续模块与结束日志
		// 获取[WebApiHost]应用程序集
		if (appconfigData.configItems.webApiHost.clientPath) {
			const copyWebApiResult = await copyAssemblyFile(
				"WebApiHost",
				projectOutPath,
				appconfigData.configItems.webApiHost
			);
			isSuccess = copyWebApiResult;
		}

		// 获取[ScheduleServer]应用程序集
		if (appconfigData.configItems.scheduleServer.clientPath && !checkStop()) {
			const copyScheduleServerResult = await copyAssemblyFile(
				"ScheduleServer",
				projectOutPath,
				appconfigData.configItems.scheduleServer
			);
			if (!copyScheduleServerResult) isSuccess = false;
		}

		// 获取[WebClient]应用程序集
		if (appconfigData.configItems.webClient.clientPath && !checkStop()) {
			const copyWebClientResult = await copyAssemblyFile(
				"WebClient",
				projectOutPath,
				appconfigData.configItems.webClient
			);
			if (!copyWebClientResult) isSuccess = false;
		}

		// 获取[SpcMonitor]应用程序集
		if (appconfigData.configItems.spcMonitor.clientPath && !checkStop()) {
			const copySpcMonitorResult = await copyAssemblyFile(
				"SpcMonitor",
				projectOutPath,
				appconfigData.configItems.spcMonitor
			);
			if (!copySpcMonitorResult) isSuccess = false;
		}

		// 获取[WpfClient]应用程序集
		if (appconfigData.configItems.wpfClient.clientPath && !checkStop()) {
			let copyWpfClientResult = false;
			if (appconfigData.configItems.isNewVersion) {
				copyWpfClientResult = await newCopyWpfAssemblyFile(
					projectOutPath,
					appconfigData.configItems.wpfClient
				);
			} else {
				copyWpfClientResult = await copyWpfAssemblyFile(
					projectOutPath,
					appconfigData.configItems.wpfClient
				);
			}
			if (!copyWpfClientResult) isSuccess = false;
		}

		if (checkStop()) return false;
		printInfoLog("获取程序集结束。");
		printInfoLog(`获取程序集总耗时：${formatElapsed(Date.now() - overallStartTime)}。`);

		// 打开输出目录
		if (isOpenDir) await cmdInvoke("open_dir", { path: projectOutPath });
		return isSuccess;
	};

	// 验证TFS本地根目录（获取程序集前校验）
	const validateTfsLocalPath = async () => {
		const appconfigData = ctx.appconfigData();
		if (appconfigData.dllMode !== "TFS") return true;
		if (!appconfigData.dllModeValue) {
			printInfoLog(`当前发布配置使用TFS获取dll，请先配置TFS获取程序集的相关信息.`, "log-error");
			return false;
		}
		const selectTfsItem = JSON.parse(appconfigData.dllModeValue) as SelectTfsType;
		const tfsItem = await getTfsDetail(Number(selectTfsItem.id));
		if (tfsItem?.tfsLocalPath) return true;
		printInfoLog(`当前发布配置使用TFS获取dll，请先在TFS配置中填写本地根目录.`, "log-error");
		return false;
	};

	// 重置发布日志上下文
	const resetPublishLogContext = () => {
		generatePublishLog.value.data = "";
		generatePublishLog.value.logs = "";
	};

	return {
		generatePublishLog,
		requestStop,
		getApplicationAssemblys,
		backupServices,
		packWpfClient,
		uploadAssemblies,
		getServiceStatuses,
		controlService,
		getStagingAssemblies,
		getLocalAssemblies,
		checkAssemblies,
		getServiceBackups,
		deleteServiceBackup,
		getServiceInstancesByServer,
		restoreServiceBackup,
		stepPublish,
		validateTfsLocalPath,
		resetPublishLogContext,
		resetStopState,
		checkStop,
	};
}

export type StepPublishApi = ReturnType<typeof useStepPublish>;
