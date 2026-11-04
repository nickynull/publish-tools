import { cmdInvoke } from "@/utils/command";

/**
 * STEP 本机配置：存 Rust config.json 的 step 段（替代原 localStorage 记忆）
 *
 * - 值统一按字符串存（与原 localStorage 语义一致），编译配置为 JSON 字符串；
 * - 进程内缓存：首次读取加载一次，写入同步更新缓存；
 * - migrateStepLocalStorage()：把旧版 localStorage 里的 STEP 记忆一次性迁入
 *   config.json 并清除旧键（升级到把配置迁到 config.json 的版本后执行）。
 */

// 迁移范围：精确键 + 前缀（STEP / 文件管理日志的所有本机记忆键）
const MIGRATE_EXACT_KEYS = [
    "stepLogMaxLines",
    "serverFileLogMaxLines",
    "stepLogShowLineNo",
    "publish_step_project_id",
    "publish_step_recent_minutes",
];
const MIGRATE_PREFIXES = ["project_environment_", "publish_step_compile_"];

let cache: Record<string, any> | null = null;
let loadPromise: Promise<Record<string, any>> | null = null;

const ensureLoaded = async (): Promise<Record<string, any>> => {
    if (cache) return cache;
    if (!loadPromise) {
        loadPromise = cmdInvoke<Record<string, any>>("get_step_config")
            .then((r) => {
                cache = r.code === 0 && r.data && typeof r.data === "object" ? r.data : {};
                return cache;
            })
            .catch(() => {
                cache = {};
                return cache;
            });
    }
    return loadPromise;
};

/** 读取 STEP 本机配置；未配置返回 fallback */
export const getStepConfigValue = async <T = string>(key: string, fallback: T): Promise<T> => {
    const map = await ensureLoaded();
    const value = map[key];
    return value === undefined || value === null ? fallback : (value as T);
};

/** 写入 STEP 本机配置（立即持久化到 config.json） */
export const setStepConfigValue = async (key: string, value: string): Promise<void> => {
    if (cache) cache[key] = value;
    await cmdInvoke("update_step_config", { entries: { [key]: value } });
};

/** 把旧版 localStorage 中的 STEP 本机记忆一次性迁入 config.json 并清除旧键（幂等，可重复调用） */
export const migrateStepLocalStorage = async () => {
    try {
        const found: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (!MIGRATE_EXACT_KEYS.includes(key) && !MIGRATE_PREFIXES.some((p) => key.startsWith(p)))
                continue;
            const value = localStorage.getItem(key);
            if (value === null) continue;
            found[key] = value;
        }
        if (Object.keys(found).length === 0) return;
        // 只补 config.json 中尚不存在的键，避免旧数据回灌覆盖已导入内容
        const loaded = await ensureLoaded();
        const fresh: Record<string, string> = {};
        for (const [key, value] of Object.entries(found)) {
            if (loaded[key] === undefined || loaded[key] === null) fresh[key] = value;
        }
        if (Object.keys(fresh).length > 0) {
            await cmdInvoke("update_step_config", { entries: fresh });
            if (cache) Object.assign(cache, fresh);
        }
        // 迁移完成即清理旧键，localStorage 不再是有效来源
        for (const key of Object.keys(found)) localStorage.removeItem(key);
    } catch (error) {
        console.error("迁移 STEP 本地存储配置失败:", error);
    }
};
