import { ref, computed, nextTick } from "vue";
import { formatDate } from "@/utils/formatTime";

/**
 * 项目发布(STEP) 日志组合式函数
 * 提供：总体日志 + 按服务实例动态标签页的日志能力（与 home 页交互模式一致，独立实现，不影响原页面）
 */
export function useStepLog() {
	const logPrintInfo = ref<LogPrintType[]>([]);
	// 日志标签页：main 为基础日志，服务操作时按实例动态创建
	const logTabs = ref<LogTabType[]>([]);
	const activeLogTab = ref<string>("main");
	const tabContentRefs = ref<Record<string, HTMLElement>>({});
	// 串行操作期间的服务日志标签页上下文，内部日志无需逐个传 tabId
	let currentLogTabId: string | undefined = undefined;

	// 展示的标签页：基础页 + 动态服务页
	const displayTabs = computed<LogTabType[]>(() => {
		const baseTab: LogTabType = {
			id: "main",
			label: "总体日志",
			logs: logPrintInfo.value,
			status: "info",
		};
		return [baseTab, ...logTabs.value];
	});

	// 创建日志标签页
	const createLogTab = (serviceName: string, serverName: string, instanceName?: string): string => {
		const id = `${serviceName}_${serverName}_${instanceName || "default"}_${Date.now()}_${logTabs.value.length}`;
		const label = instanceName
			? `${serviceName} / ${serverName} / ${instanceName}`
			: `${serviceName} / ${serverName}`;
		logTabs.value.push({ id, label, logs: [], status: "pending" });
		return id;
	};

	// 更新标签页状态
	const updateTabStatus = (tabId: string, status: LogTabType["status"]) => {
		const tab = logTabs.value.find((t) => t.id === tabId);
		if (tab) tab.status = status;
	};

	// 绑定标签页内容区 DOM 引用
	const setTabContentRef = (id: string, el: any) => {
		if (el) tabContentRefs.value[id] = el;
	};

	// 在指定日志标签页上下文中执行
	const withLogTab = async <T>(tabId: string, action: () => Promise<T>): Promise<T> => {
		const prev = currentLogTabId;
		currentLogTabId = tabId;
		try {
			return await action();
		} finally {
			currentLogTabId = prev;
		}
	};

	// 滚动到日志底部
	const scrollLogToBottom = (tabId: string) => {
		nextTick(() => {
			const el = tabContentRefs.value[tabId];
			if (el) el.scrollTop = el.scrollHeight;
		});
	};

	/**
	 * 打印日志信息
	 * @param content 日志内容
	 * @param type：log-info、log-warning、log-error、log-success
	 * @param showDate 是否显示日期
	 * @param tabId 指定日志标签页；不传则写入当前上下文所在的标签页
	 */
	const printInfoLog = (
		content: string,
		type: "log-info" | "log-warning" | "log-error" | "log-success" = "log-info",
		showDate: boolean = true,
		tabId?: string
	) => {
		let nowDate = "";
		if (showDate) {
			nowDate = `[${formatDate(new Date(), "YYYY-mm-dd HH:MM:SS")}] `;
		}
		let logContent = content ? `${nowDate}${content}` : "　";
		let logInfo: LogPrintType = {
			type,
			content: {
				value: logContent,
				uploadFile: {
					currNumber: 0,
					totalNumber: 0,
				},
			},
		};

		// 服务操作上下文：写入对应标签页
		const targetTabId = tabId ?? currentLogTabId;
		if (targetTabId) {
			const tab = logTabs.value.find((t) => t.id === targetTabId);
			if (tab) {
				tab.logs.push(logInfo);
				// 失败日志自动把仍在运行中的标签页标记为失败
				if (type === "log-error" && tab.status === "running") tab.status = "error";
				scrollLogToBottom(targetTabId);
				return tab.logs.length - 1;
			}
		}

		logPrintInfo.value.push(logInfo);
		scrollLogToBottom("main");
		return logPrintInfo.value.length - 1;
	};

	// 更新上传进度（写入当前上下文所在的日志数组）
	const updateLogProgress = (
		logIndex: number,
		prefix: string,
		currNumber: number,
		totalNumber: number,
		tabId?: string
	) => {
		const targetTabId = tabId ?? currentLogTabId;
		const logs = targetTabId
			? logTabs.value.find((t) => t.id === targetTabId)?.logs
			: logPrintInfo.value;
		if (!logs || !logs[logIndex]) return;
		logs[logIndex].content.uploadFile.prefix = prefix;
		logs[logIndex].content.uploadFile.currNumber = currNumber;
		logs[logIndex].content.uploadFile.totalNumber = totalNumber;
	};

	// 写入进度补充文本（与 updateLogProgress 同标签页路由，用于字节/百分比等补充展示）
	const setLogProgressText = (logIndex: number, text: string, tabId?: string) => {
		const targetTabId = tabId ?? currentLogTabId;
		const logs = targetTabId
			? logTabs.value.find((t) => t.id === targetTabId)?.logs
			: logPrintInfo.value;
		if (!logs || !logs[logIndex]) return;
		logs[logIndex].content.uploadFile.progressText = text;
	};

	// 清空日志
	const onRemoveLogs = () => {
		logPrintInfo.value = [];
		logTabs.value = [];
		tabContentRefs.value = {};
		activeLogTab.value = "main";
		currentLogTabId = undefined;
	};

	// 初始化日志
	const initLogs = (projectName: string, environmentName: string) => {
		printInfoLog("项目名称：" + projectName);
		printInfoLog("项目环境：" + environmentName);
	};

	// 收集失败日志（错误/警告，最近 20 条）
	const collectFailLogs = () => {
		const allLogs = logTabs.value.reduce<LogPrintType[]>(
			(acc, tab) => acc.concat(tab.logs),
			[...logPrintInfo.value]
		);
		const logs = allLogs
			.filter((log) => log.type === "log-error" || log.type === "log-warning")
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
		logTabs,
		activeLogTab,
		displayTabs,
		createLogTab,
		updateTabStatus,
		setTabContentRef,
		withLogTab,
		printInfoLog,
		updateLogProgress,
		setLogProgressText,
		onRemoveLogs,
		initLogs,
		collectFailLogs,
	};
}

export type StepLogApi = ReturnType<typeof useStepLog>;
