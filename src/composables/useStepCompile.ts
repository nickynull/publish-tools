import { computed, ref, watch } from "vue";
import { cmdInvoke } from "@/utils/command";
import { removeSlash } from "@/utils/other";
import { isPullLatestEnabled, pullLatestCode } from "@/utils/sourceControl";
import type { StepLogApi } from "./useStepLog";

/**
 * 项目发布(STEP)【编译解决方案】业务组合式函数
 *
 * 与主页【编译项目】的区别：用一次 MSBuild 调用编译整个解决方案（.sln），
 * 不再逐个 csproj 编译，也不删除各模块生成目录。
 *
 * 独立性约定：
 * - 解决方案路径来自应用配置（t_app_config.solution_path），发布信息卡调整后实时落库，
 *   不存 localStorage；生成模式 / 平台 / 方式等编译参数存本机
 *   （localStorage，按「项目 + 环境」记忆）；
 * - 编译前是否先获取一遍最新代码由发布信息卡「拉取最新代码」开关控制
 *   （存应用配置 configItems.isPullLatest）；
 * - 不调用 useStepPublish 内部逻辑（仅通过注入的 checkStop 读取停止标记），
 *   页面原有功能不受影响。
 */

// 编译配置（本步骤独立维护，存本机）
export type StepCompileConfig = {
	buildMode: string; // 生成模式 Release / Debug
	platform: string; // 平台 Any CPU / x64 / x86（留空表示交给解决方案自身配置）
	isRebuild: boolean; // true 重新生成(Rebuild) / false 增量生成(Build)
	msBuildPath: string; // MSBuild 路径（留空则用应用配置，仍为空时自动探测）
};

// 本步骤配置在本机的存储键前缀（后接 项目 id + 环境）
const COMPILE_STORAGE_KEY_PREFIX = "publish_step_compile";

// 可选生成模式与平台（与内置 bat 脚本模板保持一致）
export const stepCompileBuildModes = ["Release", "Debug"];
export const stepCompilePlatforms = ["Any CPU", "x64", "x86"];

// 日志最多打印的错误行数（其余只提示条数，避免刷屏）
const MAX_ERROR_LOG_LINES = 60;

// 当前「项目 + 环境」的存储键（未选项目/环境时为空，不读不写）
const getCompileStorageKey = (projectId: any, environment: any) => {
	const pid = Number(projectId) || 0;
	const env = Number(environment) || 0;
	return pid > 0 && env > 0 ? `${COMPILE_STORAGE_KEY_PREFIX}_${pid}_${env}` : "";
};

// 应用配置推导的默认值（本步骤未单独配置时使用）
const createDefaultConfig = (appconfigData?: RowAppconfigType | null): StepCompileConfig => ({
	buildMode: appconfigData?.buildMode ? String(appconfigData.buildMode) : "Release",
	platform: "Any CPU",
	// isRebuild=1 表示重新编译，与应用配置「是否重新生成」保持一致
	isRebuild: Number(appconfigData?.configItems?.isRebuild ?? 1) === 1,
	msBuildPath: "",
});

// 读取当前「项目 + 环境」的编译配置（本机未保存过则用应用配置默认值）
export const loadStepCompileConfig = (
	appconfigData: RowAppconfigType | null | undefined,
	projectId: any,
	environment: any
): StepCompileConfig => {
	const defaults = createDefaultConfig(appconfigData);
	const storageKey = getCompileStorageKey(projectId, environment);
	if (!storageKey) return defaults;
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) return defaults;
		const saved = JSON.parse(raw) as Partial<StepCompileConfig>;
		return {
			buildMode: String(saved.buildMode || defaults.buildMode),
			platform: String(saved.platform || defaults.platform),
			isRebuild: typeof saved.isRebuild === "boolean" ? saved.isRebuild : defaults.isRebuild,
			msBuildPath: String(saved.msBuildPath || ""),
		};
	} catch (error) {
		console.error("读取编译解决方案配置失败:", error);
		return defaults;
	}
};

// 保存当前「项目 + 环境」的编译配置（localStorage 不可用时仅本次会话生效）
export const saveStepCompileConfig = (
	projectId: any,
	environment: any,
	config: StepCompileConfig
) => {
	const storageKey = getCompileStorageKey(projectId, environment);
	if (!storageKey) return;
	try {
		localStorage.setItem(storageKey, JSON.stringify(config));
	} catch (error) {
		console.error("保存编译解决方案配置失败:", error);
	}
};

// 上下文：由页面提供响应式数据的读取器（不直接依赖页面 state）
export type StepCompileContext = {
	projectId: () => any;
	environment: () => number | null;
	appconfigData: () => RowAppconfigType;
	/** 应用配置的「解决方案路径」（t_app_config.solution_path，发布信息卡调整后实时落库） */
	appconfigSolutionPath?: () => string | null | undefined;
	/** 是否已请求停止（编译中途点【停止】由它判定，由页面注入） */
	checkStop?: () => boolean;
};

export function useStepCompile(ctx: StepCompileContext, log: StepLogApi) {
	const { printInfoLog } = log;

	// 当前「项目 + 环境」的编译配置
	const config = ref<StepCompileConfig>(createDefaultConfig());
	// 存储键（项目/环境变化即切换配置）
	const storageKey = computed(() => getCompileStorageKey(ctx.projectId(), ctx.environment()));

	// 重新读取配置：切换项目/环境、应用配置换掉后都会走这里
	const reloadConfig = () => {
		config.value = loadStepCompileConfig(ctx.appconfigData(), ctx.projectId(), ctx.environment());
	};

	// 应用配置 id 参与监听：首次加载时项目/环境先就绪、应用配置后到达，
	// 只监听存储键会漏掉「默认值来源（生成模式/是否重新生成）变化」
	const configSourceKey = computed(
		() => `${storageKey.value}|${Number(ctx.appconfigData()?.id) || 0}`
	);
	watch(configSourceKey, reloadConfig, { immediate: true });

	// 局部更新配置并立即落盘（页面与设置条统一走这里，保证内存与 localStorage 一致）
	const setConfig = (patch: Partial<StepCompileConfig>) => {
		config.value = { ...config.value, ...patch };
		saveStepCompileConfig(ctx.projectId(), ctx.environment(), config.value);
	};

	// 毫秒转可读时长
	const formatElapsed = (elapsedMs: number) => {
		return elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)} 秒` : `${elapsedMs} 毫秒`;
	};

	// 解析 MSBuild 路径：本步骤配置 > 应用配置 > vswhere 自动探测
	const resolveMsBuildPath = async (): Promise<{ path: string; source: string }> => {
		let msBuildPath = removeSlash(String(config.value.msBuildPath || "").trim());
		if (msBuildPath) return { path: msBuildPath, source: "本步骤配置" };

		msBuildPath = removeSlash(String(ctx.appconfigData()?.msBuildPath || "").trim());
		if (msBuildPath) return { path: msBuildPath, source: "应用配置" };

		const found = await cmdInvoke<string>("find_msbuild_path");
		if (found.code === 0 && found.data) {
			return { path: removeSlash(String(found.data)), source: "自动探测" };
		}
		return { path: "", source: "" };
	};

	// 编译解决方案：一次 MSBuild 调用编译整个 .sln，返回是否成功
	const compileSolution = async (): Promise<boolean> => {
		// 0. 编译前置拉取最新代码：受发布信息卡「拉取最新代码」开关控制（存应用配置，缺省开启）
		if (isPullLatestEnabled(ctx.appconfigData()?.configItems)) {
			printInfoLog("开始获取最新代码（编译解决方案前置步骤）...");
			const pullResult = await pullLatestCode(ctx.appconfigData(), {
				log: (content, type) => printInfoLog(content, type),
			});
			if (pullResult.code !== 0) {
				printInfoLog("获取最新代码失败，已中止编译.", "log-error");
				return false;
			}
			// skipped：未执行拉取（非 TFS/Git、缺配置、分支不一致），原因已由 pullLatestCode 打印，不阻断编译
		}

		// 1. 解决方案文件：来自应用配置（发布信息卡调整后实时落库），必须已配置且存在
		const solutionPath = removeSlash(String(ctx.appconfigSolutionPath?.() || "").trim());
		if (!solutionPath) {
			printInfoLog(
				"未配置解决方案文件：请在应用配置中维护「解决方案」路径，或在本页「发布信息 → 解决方案」中点【选择】指定（实时落库）.",
				"log-error"
			);
			return false;
		}
		const solutionExists = await cmdInvoke("exists", { path: solutionPath });
		if (solutionExists.code !== 0) {
			printInfoLog(`解决方案文件不存在：${solutionPath}，请重新选择.`, "log-error");
			return false;
		}

		// 2. MSBuild 路径：本步骤配置 > 应用配置 > 自动探测，且必须存在
		const msBuild = await resolveMsBuildPath();
		if (!msBuild.path) {
			printInfoLog(
				"未配置 [MSBuild 路径]：请在应用配置中填写，或在本步骤的编译配置中指定.",
				"log-error"
			);
			return false;
		}
		const msBuildExists = await cmdInvoke("exists", { path: msBuild.path });
		if (msBuildExists.code !== 0) {
			printInfoLog(`MSBuild 路径不存在：${msBuild.path}，请检查配置.`, "log-error");
			return false;
		}

		// 3. 编译参数与来源写进日志，便于排查「编译出来的 dll 不对」
		const buildMode = String(config.value.buildMode || "Release");
		const platform = String(config.value.platform || "");
		const isRebuild = !!config.value.isRebuild;
		printInfoLog(`开始编译解决方案：${solutionPath}`);
		printInfoLog(
			`生成模式：${buildMode}；平台：${platform || "（解决方案默认）"}；方式：${isRebuild ? "重新生成(Rebuild)" : "增量生成(Build)"}`
		);
		printInfoLog(`MSBuild（${msBuild.source}）：${msBuild.path}`);
		if (ctx.checkStop?.()) return false;
		printInfoLog(
			"编译中：解决方案较大时 MSBuild 耗时较长，请耐心等待（可点【停止】中断编译）...",
			"log-warning"
		);

		const startTime = Date.now();
		const result = await cmdInvoke<boolean>("build_solution_release", {
			solutionPath,
			msbuildPath: msBuild.path,
			isRebuild,
			buildMode,
			platform,
		});
		const elapsed = formatElapsed(Date.now() - startTime);

		// 4. 结果处理：主动停止按警告记一条，编译失败逐行打印错误
		if (result.code !== 0) {
			const raw = String(result.data ?? result.msg ?? "");
			if (raw.includes("已手动停止")) {
				printInfoLog(`编译已被手动停止（耗时 ${elapsed}）`, "log-warning");
				return false;
			}
			printInfoLog(`编译解决方案失败（耗时 ${elapsed}）`, "log-error");
			const errorLines = raw
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			for (const line of errorLines.slice(0, MAX_ERROR_LOG_LINES)) {
				printInfoLog(line, "log-error");
			}
			if (errorLines.length > MAX_ERROR_LOG_LINES) {
				printInfoLog(
					`其余 ${errorLines.length - MAX_ERROR_LOG_LINES} 条错误已省略，可修复后重新编译.`,
					"log-warning"
				);
			}
			if (errorLines.length === 0) {
				printInfoLog("未获取到错误输出，请检查 MSBuild 路径与解决方案配置.", "log-error");
			}
			return false;
		}

		printInfoLog(`编译解决方案成功（耗时 ${elapsed}）：${solutionPath}`, "log-success");
		return true;
	};

	return {
		config,
		storageKey,
		setConfig,
		reloadConfig,
		compileSolution,
	};
}

export type StepCompileApi = ReturnType<typeof useStepCompile>;
