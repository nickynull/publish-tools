import { useSettingsDb } from '@/database/settings/index';

const _default: RowSettingsType = {
    id: 1,
    oneClickPublishEnabled: 0,
    winServiceRetryCount: 3,
    winServiceRetryInterval: 2,
    winCopyRetryCount: 3,
    winCopyRetryInterval: 2,
    uploadRetryCount: 99,
    uploadRetryInterval: 3,
    winServiceStartTimeout: 20,
    winServiceStopTimeout: 20,
    publishModuleOrder: 'WebApiHost,WebClient,ScheduleServer,WpfClient,SpcMonitor',
    sshMcpUrl: 'http://127.0.0.1:61823',
    sshMcpAutoSync: 0,
    startupMenu: 'workstation',
    updateTime: '',
};

/** 发布模块的默认顺序（项目发布(STEP) 备份/上传/发布共用） */
export const DEFAULT_PUBLISH_MODULE_ORDER = ['WebApiHost', 'WebClient', 'ScheduleServer', 'WpfClient', 'SpcMonitor'];

export function defaultSettings(): RowSettingsType {
    return { ..._default };
}

let cached: RowSettingsType | null = null;

/**
 * 查 DB 并刷新模块级缓存。
 * 设置页保存后经 mittBus 'settingsChanged' 触发重载；发布/还原流程入口也会调用。
 */
export async function loadPublishSettings(): Promise<RowSettingsType> {
    const r = await useSettingsDb().getSettings();
    cached = r.code === 0 && r.data ? r.data : defaultSettings();
    return cached;
}

/**
 * 同步读缓存的重试参数。调用前应已 await loadPublishSettings()。
 * group='service' → Windows 服务启动/关闭命令；group='copy' → copy_path；group='upload' → upload_server_files（项目发布上传重试）。
 *
 * 键名必须是 camelCase：Tauri command 参数按 camelCase 键取值（Rust 端 retry_count → 前端 retryCount），
 * 传 snake_case 键时 Option 参数会静默取 None（不报错），导致重试设置失效、恒走默认值。
 */
export function getRetryArgs(group: 'service' | 'copy' | 'upload'): {
    retryCount: number;
    retryIntervalSecs: number;
} {
    const s = cached ?? defaultSettings();
    if (group === 'service')
        return { retryCount: s.winServiceRetryCount, retryIntervalSecs: s.winServiceRetryInterval };
    if (group === 'copy')
        return { retryCount: s.winCopyRetryCount, retryIntervalSecs: s.winCopyRetryInterval };
    return { retryCount: s.uploadRetryCount, retryIntervalSecs: s.uploadRetryInterval };
}

/**
 * 同步读缓存的 Windows 服务启停等待超时（秒）。
 * startTimeoutSecs → sc start 后轮询确认启动的最长等待；stopTimeoutSecs → sc stop 同理。
 * 调用前应已 await loadPublishSettings()。
 */
export function getServiceWaitTimeouts(): { startTimeoutSecs: number; stopTimeoutSecs: number } {
    const s = cached ?? defaultSettings();
    return {
        startTimeoutSecs: Number(s.winServiceStartTimeout) > 0 ? Number(s.winServiceStartTimeout) : 20,
        stopTimeoutSecs: Number(s.winServiceStopTimeout) > 0 ? Number(s.winServiceStopTimeout) : 60,
    };
}

/**
 * 解析发布模块顺序字符串（逗号分隔）。模块不全/重复/为空时回退默认顺序。
 */
export function parsePublishModuleOrder(raw: string): string[] {
    const list = String(raw || '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
    const valid =
        list.length === DEFAULT_PUBLISH_MODULE_ORDER.length &&
        DEFAULT_PUBLISH_MODULE_ORDER.every((name) => list.includes(name));
    return valid ? list : [...DEFAULT_PUBLISH_MODULE_ORDER];
}

/**
 * 同步读缓存的发布模块顺序（项目发布(STEP) 备份/上传/发布共用）。
 * 配置缺失/模块不全/重复时回退默认顺序；顺序外的模块名排在末尾（由调用方处理）。
 * 调用前应已 await loadPublishSettings()。
 */
export function getPublishModuleOrder(): string[] {
    const s = cached ?? defaultSettings();
    return parsePublishModuleOrder(String(s.publishModuleOrder || ''));
}
