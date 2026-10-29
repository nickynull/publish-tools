import { ref, nextTick } from "vue";
import { formatDate } from "@/utils/formatTime";

// 日志行数上限默认配置：存 localStorage（本机记忆，无需入库）
const STEP_LOG_MAX_LINES_KEY = "stepLogMaxLines";
const STEP_LOG_MAX_LINES_DEFAULT = 1000;
const STEP_LOG_MAX_LINES_MIN = 10;
const STEP_LOG_MAX_LINES_MAX = 100000;

/** 可选配置：不同使用方可用独立的 localStorage 键与默认上限（不传时保持现状） */
export type StepLogOptions = {
	/** 行数上限的 localStorage 键（默认 stepLogMaxLines） */
	maxLinesStorageKey?: string;
	/** 默认行数上限（默认 1000） */
	defaultMaxLines?: number;
};

/**
 * 项目发布(STEP) 日志组合式函数
 * 所有日志输出到唯一日志区（单页签），带行数上限（超出后清理最旧的行）；
 * 进度行通过自增 id 寻址（行数裁剪会使数组下标前移，不能再用下标定位）。
 */
export function useStepLog(options?: StepLogOptions) {
	const maxLinesKey = options?.maxLinesStorageKey ?? STEP_LOG_MAX_LINES_KEY;
	const defaultMaxLines = options?.defaultMaxLines ?? STEP_LOG_MAX_LINES_DEFAULT;
	const logPrintInfo = ref<LogPrintType[]>([]);
	// 日志内容容器（唯一），用于自动滚动到底部
	let logContentEl: HTMLElement | null = null;
	// 自增日志 id：printInfoLog 返回，供进度更新按 id 定位
	let nextLogId = 1;

	// 行数上限：初始化时读 localStorage，非法/缺失回退默认
	const maxLogLines = ref<number>(loadMaxLines());

	function loadMaxLines(): number {
		try {
			const raw = localStorage.getItem(maxLinesKey);
			if (!raw) return defaultMaxLines;
			return clampMaxLines(Number(raw));
		} catch {
			return defaultMaxLines;
		}
	}

	function clampMaxLines(n: number): number {
		if (!Number.isFinite(n)) return defaultMaxLines;
		return Math.min(STEP_LOG_MAX_LINES_MAX, Math.max(STEP_LOG_MAX_LINES_MIN, Math.round(n)));
	}

	// 超出行数上限时一次裁掉最旧的超出部分，保留最新 max 行
	const trimLogs = () => {
		const max = maxLogLines.value;
		if (logPrintInfo.value.length > max) {
			logPrintInfo.value.splice(0, logPrintInfo.value.length - max);
		}
	};

	// 设置行数上限：校验并夹取范围后写 ref + localStorage，并立即裁剪一次
	const setMaxLogLines = (n: number) => {
		const value = clampMaxLines(Number(n));
		maxLogLines.value = value;
		try {
			localStorage.setItem(maxLinesKey, String(value));
		} catch {
			// localStorage 不可用时仅本次会话生效
		}
		trimLogs();
	};

	// 绑定日志内容区 DOM 引用
	const setLogContentRef = (el: any) => {
		if (el) logContentEl = el;
	};

	// 滚动到日志底部
	const scrollLogToBottom = () => {
		nextTick(() => {
			if (logContentEl) logContentEl.scrollTop = logContentEl.scrollHeight;
		});
	};

	/**
	 * 打印日志信息
	 * @param content 日志内容
	 * @param type：log-info、log-warning、log-error、log-success
	 * @param showDate 是否显示日期
	 * @returns 日志行 id（供 updateLogProgress / setLogProgressText 定位）
	 */
	const printInfoLog = (
		content: string,
		type: "log-info" | "log-warning" | "log-error" | "log-success" = "log-info",
		showDate: boolean = true
	): number => {
		let nowDate = "";
		if (showDate) {
			nowDate = `[${formatDate(new Date(), "YYYY-mm-dd HH:MM:SS")}] `;
		}
		let logContent = content ? `${nowDate}${content}` : "　";
		const logId = nextLogId++;
		const logInfo: LogPrintType = {
			id: logId,
			type,
			content: {
				value: logContent,
				uploadFile: {
					currNumber: 0,
					totalNumber: 0,
				},
			},
		};
		logPrintInfo.value.push(logInfo);
		trimLogs();
		scrollLogToBottom();
		return logId;
	};

	// 打印操作分割线：用于划分不同功能操作的日志区间（label 可选，显示在分割线中间）
	const printLogDivider = (label: string = "") => {
		const logId = nextLogId++;
		const logInfo: LogPrintType = {
			id: logId,
			type: "log-info",
			divider: true,
			content: {
				value: label,
				uploadFile: {
					currNumber: 0,
					totalNumber: 0,
				},
			},
		};
		logPrintInfo.value.push(logInfo);
		trimLogs();
		scrollLogToBottom();
		return logId;
	};

	// 按 id 查找日志行（被行数裁剪清掉的行静默跳过）
	const findLogById = (logId: number) => logPrintInfo.value.find((l) => l.id === logId);

	// 更新上传进度（按 id 定位日志行）
	const updateLogProgress = (
		logId: number,
		prefix: string,
		currNumber: number,
		totalNumber: number
	) => {
		const log = findLogById(logId);
		if (!log) return;
		log.content.uploadFile.prefix = prefix;
		log.content.uploadFile.currNumber = currNumber;
		log.content.uploadFile.totalNumber = totalNumber;
	};

	// 写入进度补充文本（按 id 定位日志行，用于字节/百分比等补充展示）
	const setLogProgressText = (logId: number, text: string) => {
		const log = findLogById(logId);
		if (!log) return;
		log.content.uploadFile.progressText = text;
	};

	// 清空日志
	const onRemoveLogs = () => {
		logPrintInfo.value = [];
	};

	// 初始化日志
	const initLogs = (projectName: string, environmentName: string) => {
		printInfoLog("项目名称：" + projectName);
		printInfoLog("项目环境：" + environmentName);
	};

	// 收集失败日志（错误/警告，最近 20 条），跳过分割线行
	const collectFailLogs = () => {
		const logs = logPrintInfo.value
			.filter((log) => !log.divider && (log.type === "log-error" || log.type === "log-warning"))
			.map((log) => log.content.value)
			.filter(Boolean);
		const recentLogs = logs.slice(-20);
		if (recentLogs.length > 0) {
			return `失败日志（共${logs.length}条）:\n${recentLogs.join("\n")}`;
		}
		return "";
	};

	return {
		logPrintInfo,
		maxLogLines,
		setMaxLogLines,
		setLogContentRef,
		printInfoLog,
		printLogDivider,
		updateLogProgress,
		setLogProgressText,
		onRemoveLogs,
		initLogs,
		collectFailLogs,
	};
}

export type StepLogApi = ReturnType<typeof useStepLog>;
