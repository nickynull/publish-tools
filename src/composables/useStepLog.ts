import { ref, nextTick } from "vue";
import { formatDate } from "@/utils/formatTime";
import { getStepConfigValue, setStepConfigValue } from "@/utils/stepLocalConfig";

// 日志行数上限默认配置：存 config.json 的 step 段（原 localStorage，本机记忆无需入库）
const STEP_LOG_MAX_LINES_KEY = "stepLogMaxLines";
const STEP_LOG_MAX_LINES_DEFAULT = 1000;
const STEP_LOG_MAX_LINES_MIN = 10;
const STEP_LOG_MAX_LINES_MAX = 100000;

/** 可选配置：不同使用方可用独立的配置键与默认上限（不传时保持现状） */
export type StepLogOptions = {
	/** 行数上限的配置键（默认 stepLogMaxLines） */
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

	// 行数上限：默认值先占位，config.json 读取后异步回填（非法值回退默认）
	const maxLogLines = ref<number>(defaultMaxLines);

	getStepConfigValue<string>(maxLinesKey, String(defaultMaxLines)).then((raw) => {
		maxLogLines.value = clampMaxLines(Number(raw));
		trimLogs();
	});

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

	// 设置行数上限：校验并夹取范围后写 ref + config.json，并立即裁剪一次
	const setMaxLogLines = (n: number) => {
		const value = clampMaxLines(Number(n));
		maxLogLines.value = value;
		setStepConfigValue(maxLinesKey, String(value)).catch((error) => {
			console.error("保存日志行数上限失败:", error);
		});
		trimLogs();
	};

	// 距底部多少像素内视为「贴底」：自动到底只在贴底状态生效，否则会打断用户翻历史
	const BOTTOM_THRESHOLD = 8;
	// 自动到底开关：点【回到顶部】或手动上翻离开底部后暂停，滚回底部（或点【回到底部】）恢复
	let autoScrollEnabled = true;
	// 最后一次滚动位置：keep-alive 页面失活时 DOM 脱离文档会被浏览器重置 scrollTop，返回时按此恢复
	let lastScrollTop = 0;

	// 是否已滚动到底部（内容不足一屏时始终算贴底）
	const isNearBottom = () => {
		if (!logContentEl) return true;
		const { scrollTop, scrollHeight, clientHeight } = logContentEl;
		return scrollHeight - (scrollTop + clientHeight) <= BOTTOM_THRESHOLD;
	};

	// 滚动监听：不区分程序性滚动还是用户手动滚动，统一按「最终是否贴底」校正开关
	const onLogScroll = () => {
		if (logContentEl) lastScrollTop = logContentEl.scrollTop;
		autoScrollEnabled = isNearBottom();
	};

	/**
	 * 绑定日志内容区 DOM 引用
	 * 注意：组件卸载 / 元素换绑时 Vue 会以 null 回调，必须一并清空引用。
	 * 若沿用 `if (el)` 写法，logContentEl 会悬空指向已脱离文档的旧节点
	 * （如页签右键刷新导致组件重建），后续自动滚动全部写到废弃元素上、表现成「日志不再自动到底」。
	 */
	const setLogContentRef = (el: any) => {
		const next = (el as HTMLElement | null) ?? null;
		// 换绑（含重复挂载）前解绑旧节点，避免滚动监听叠加
		if (logContentEl && logContentEl !== next) logContentEl.removeEventListener("scroll", onLogScroll);
		logContentEl = next;
		if (next) next.addEventListener("scroll", onLogScroll, { passive: true });
	};

	// 纯滚动到底：不做开关判断，供自动到底与【回到底部】共用
	const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
		nextTick(() => {
			if (logContentEl) logContentEl.scrollTo({ top: logContentEl.scrollHeight, behavior });
		});
	};

	// 自动到底：跟随最新一行（用户已上翻离开底部或点了【回到顶部】时不动，避免把视图拽回去）
	const autoScrollToBottom = () => {
		if (!autoScrollEnabled) return;
		scrollToBottom();
	};

	// 【回到底部】按钮：恢复自动到底并立即滚到最新一行
	const scrollLogToBottom = (behavior: ScrollBehavior = "auto") => {
		autoScrollEnabled = true;
		scrollToBottom(behavior);
	};

	// 【回到顶部】按钮：暂停自动到底，否则持续输出的新日志会把视图立刻拽回底部
	const scrollLogToTop = (behavior: ScrollBehavior = "smooth") => {
		// 内容不足一屏时没有历史可看，保持跟随最新行（否则按钮会把自动到底永久关掉）
		const scrollable = logContentEl
			? logContentEl.scrollHeight - logContentEl.clientHeight > BOTTOM_THRESHOLD
			: false;
		autoScrollEnabled = !scrollable;
		nextTick(() => {
			if (logContentEl) logContentEl.scrollTo({ top: 0, behavior });
		});
	};

	// 页面重新激活（keep-alive 返回）时恢复滚动视图：跟随状态直接回到底部，否则回到离开前的位置
	// （失活期间 DOM 脱离文档，scrollTop 已被浏览器重置为 0；失活期间新日志继续输出，历史位置为近似恢复）
	const restoreLogScroll = () => {
		nextTick(() => {
			if (!logContentEl) return;
			if (autoScrollEnabled) {
				logContentEl.scrollTo({ top: logContentEl.scrollHeight });
			} else {
				logContentEl.scrollTop = lastScrollTop;
			}
		});
	};

	/**
	 * 打印日志信息
	 * @param content 日志内容
	 * @param type：log-info、log-warning、log-error、log-success、log-primary
	 * @param showDate 是否显示日期
	 * @returns 日志行 id（供 updateLogProgress / setLogProgressText 定位）
	 */
	const printInfoLog = (
		content: string,
		type: "log-info" | "log-warning" | "log-error" | "log-success" | "log-primary" = "log-info",
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
		autoScrollToBottom();
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
		autoScrollToBottom();
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

	// 清空日志：视为重新开始跟随最新输出
	const onRemoveLogs = () => {
		logPrintInfo.value = [];
		autoScrollEnabled = true;
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
		scrollLogToTop,
		scrollLogToBottom,
		restoreLogScroll,
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
