/**
 * 页签关闭守卫
 *
 * 用途：页面存在「不可打断的进行中任务」（如服务器文件管理正在上传/下载/读取目录）时，
 * 阻止用户通过页签 ×、右键菜单、中键或页面按钮关闭页签。
 *
 * 页签列表是 tagsView 组件的内部状态，页面侧无法直接访问，因此由页面注册守卫、
 * tagsView 在关闭前主动询问：命中守卫且返回拦截原因即放弃关闭。
 */

/** 守卫匹配所用到的页签信息（RouteItem 的子集） */
export type TabCloseGuardTarget = {
    path?: string;
    query?: Record<string, any>;
    params?: Record<string, any>;
};

export type TabCloseGuard = {
    /** 判断该守卫是否负责这个页签 */
    match: (tab: TabCloseGuardTarget) => boolean;
    /** 返回拦截原因，返回 null 表示允许关闭 */
    blockReason: () => string | null;
};

const guards: TabCloseGuard[] = [];

/**
 * 注册页签关闭守卫
 * @param guard 守卫
 * @returns 反注册函数（页面卸载时调用）
 */
export const registerTabCloseGuard = (guard: TabCloseGuard): (() => void) => {
    guards.push(guard);
    return () => {
        const index = guards.indexOf(guard);
        if (index > -1) guards.splice(index, 1);
    };
};

/**
 * 获取页签的拦截原因
 * @param tab 待关闭的页签
 * @returns 拦截原因；无守卫拦截时返回 null
 */
export const getTabCloseBlockReason = (tab: TabCloseGuardTarget): string | null => {
    for (const guard of guards) {
        if (!guard.match(tab)) continue;
        const reason = guard.blockReason();
        if (reason) return reason;
    }
    return null;
};
