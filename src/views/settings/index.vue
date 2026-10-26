<template>
    <div class="settings-container layout-padding">
        <!-- 配置内容：纵向溢出时内部滚动 -->
        <div class="settings-body">
            <el-card shadow="never">
                <el-form ref="formRef" :model="form" label-width="180px" size="default" v-loading="loading">
                    <!-- 开机自启 -->
                    <el-divider content-position="left">{{ $t('message.settings.autoStart') }}</el-divider>
                    <el-form-item :label="$t('message.settings.autoStart')">
                        <el-switch v-model="autoStartEnabled" :loading="autoStartLoading" @change="onAutoStartChange" />
                        <span class="settings-tip">{{ $t('message.settings.autoStartTip') }}</span>
                    </el-form-item>

                    <!-- 启动默认菜单 -->
                    <el-form-item :label="$t('message.settings.startupMenu')">
                        <el-radio-group v-model="form.startupMenu">
                            <el-radio value="workstation">{{ $t('message.settings.startupMenuWorkstation') }}</el-radio>
                            <el-radio value="home">{{ $t('message.settings.startupMenuHome') }}</el-radio>
                            <el-radio value="publishStep">{{ $t('message.settings.startupMenuPublishStep') }}</el-radio>
                        </el-radio-group>
                        <span class="settings-tip">{{ $t('message.settings.startupMenuTip') }}</span>
                    </el-form-item>

                    <!-- 一键发布 -->
                    <el-divider content-position="left">{{ $t('message.settings.oneClickPublish') }}</el-divider>
                    <el-form-item :label="$t('message.settings.oneClickPublish')">
                        <el-switch v-model="form.oneClickPublishEnabled" :active-value="1" :inactive-value="0" />
                        <span class="settings-tip">{{ $t('message.settings.oneClickPublishTip') }}</span>
                    </el-form-item>

                    <!-- 服务启停重试 -->
                    <el-divider content-position="left">{{ $t('message.settings.winServiceRetry') }}</el-divider>
                    <el-form-item :label="$t('message.settings.retryCount')">
                        <el-input-number v-model="form.winServiceRetryCount" :min="1" :max="99" :step="1" />
                    </el-form-item>
                    <el-form-item :label="$t('message.settings.retryInterval')">
                        <el-input-number v-model="form.winServiceRetryInterval" :min="1" :max="60" :step="1" />
                    </el-form-item>

                    <!-- 复制重试 -->
                    <el-divider content-position="left">{{ $t('message.settings.winCopyRetry') }}</el-divider>
                    <el-form-item :label="$t('message.settings.retryCount')">
                        <el-input-number v-model="form.winCopyRetryCount" :min="1" :max="99" :step="1" />
                    </el-form-item>
                    <el-form-item :label="$t('message.settings.retryInterval')">
                        <el-input-number v-model="form.winCopyRetryInterval" :min="1" :max="60" :step="1" />
                    </el-form-item>

                    <!-- 上传重试 -->
                    <el-divider content-position="left">{{ $t('message.settings.uploadRetry') }}</el-divider>
                    <el-form-item :label="$t('message.settings.retryCount')">
                        <el-input-number v-model="form.uploadRetryCount" :min="1" :max="99" :step="1" />
                        <span class="settings-tip">{{ $t('message.settings.uploadRetryTip') }}</span>
                    </el-form-item>
                    <el-form-item :label="$t('message.settings.retryInterval')">
                        <el-input-number v-model="form.uploadRetryInterval" :min="1" :max="60" :step="1" />
                    </el-form-item>

                    <!-- 服务启停等待超时 -->
                    <el-divider content-position="left">{{ $t('message.settings.winServiceTimeout') }}</el-divider>
                    <el-form-item :label="$t('message.settings.startTimeout')">
                        <el-input-number v-model="form.winServiceStartTimeout" :min="5" :max="300" :step="1" />
                        <span class="settings-tip">{{ $t('message.settings.startTimeoutTip') }}</span>
                    </el-form-item>
                    <el-form-item :label="$t('message.settings.stopTimeout')">
                        <el-input-number v-model="form.winServiceStopTimeout" :min="5" :max="300" :step="1" />
                        <span class="settings-tip">{{ $t('message.settings.stopTimeoutTip') }}</span>
                    </el-form-item>

                    <!-- 发布顺序 -->
                    <el-divider content-position="left">{{ $t('message.settings.publishOrder') }}</el-divider>
                    <el-form-item :label="$t('message.settings.publishOrder')">
                        <div class="order-list">
                            <div v-for="(name, idx) in publishOrderList" :key="name" class="order-item">
                                <span class="order-idx">{{ idx + 1 }}</span>
                                <span class="order-name">{{ name }}</span>
                                <el-button size="small" :disabled="idx === 0" @click="moveOrder(idx, -1)">{{
                                    $t('message.settings.moveUp') }}</el-button>
                                <el-button size="small" :disabled="idx === publishOrderList.length - 1"
                                    @click="moveOrder(idx, 1)">{{ $t('message.settings.moveDown') }}</el-button>
                            </div>
                        </div>
                        <span class="settings-tip">{{ $t('message.settings.publishOrderTip') }}</span>
                    </el-form-item>

                    <!-- MCP 服务配置 -->
                    <el-divider content-position="left">{{ $t('message.settings.mcp') }}</el-divider>
                    <el-form-item :label="$t('message.settings.mcpEnabled')">
                        <el-switch v-model="mcpConfig.mcp_enabled" @change="onMcpEnabledChange" />
                        <span class="settings-tip">{{ $t('message.settings.mcpEnabledTip') }}</span>
                    </el-form-item>
                    <el-form-item :label="$t('message.settings.mcpPort')">
                        <el-input-number v-model="mcpConfig.mcp_port" :min="1024" :max="65535" :step="1"
                            :disabled="mcpConfig.mcp_enabled" />
                    </el-form-item>
                    <el-form-item :label="$t('message.settings.mcpStatus')">
                        <el-tag :type="mcpStatusTagType">{{ $t(mcpStatusI18nKey) }}</el-tag>
                    </el-form-item>

                    <!-- SSH MCP 配置同步 -->
                    <el-divider content-position="left">{{ $t('message.settings.sshMcp') }}</el-divider>
                    <el-form-item :label="$t('message.settings.sshMcpUrl')">
                        <el-input v-model="form.sshMcpUrl" placeholder="http://127.0.0.1:61823" style="width: 320px" />
                        <span class="settings-tip">{{ $t('message.settings.sshMcpUrlTip') }}</span>
                    </el-form-item>
                    <el-form-item :label="$t('message.settings.sshMcpAutoSync')">
                        <el-switch v-model="form.sshMcpAutoSync" :active-value="1" :inactive-value="0" />
                        <span class="settings-tip">{{ $t('message.settings.sshMcpAutoSyncTip') }}</span>
                    </el-form-item>
                </el-form>
            </el-card>

            <!-- 服务发现前缀管理 -->
            <el-card shadow="never" v-loading="prefixLoading" style="margin-top: 15px">
                <template #header>
                    <span>服务发现前缀</span>
                    <span class="settings-tip" style="margin-left: 8px">用于扫描本机/远端服务时匹配服务名前缀</span>
                </template>
                <div class="prefix-tags" style="margin-bottom: 16px">
                    <div v-for="item in prefixList" :key="item.id ?? item.prefix" class="prefix-tag-row">
                        <el-tag :type="item.isDefault === 1 ? 'info' : undefined" :closable="item.isDefault !== 1"
                            size="default" @close="onDeletePrefix(item)">
                            {{ item.prefix }}
                            <span v-if="item.isDefault === 1"
                                style="margin-left: 4px; font-size: 11px; opacity: 0.7">(默认)</span>
                        </el-tag>
                        <el-switch v-model="item.enabled" :active-value="1" :inactive-value="0" size="small"
                            style="margin-left: 8px" @change="onTogglePrefixEnabled(item)" />
                        <span class="settings-tip" style="margin-left: 6px">{{ item.enabled === 1 ? '启用' : '禁用'
                            }}</span>
                    </div>
                    <el-empty v-if="!prefixList.length && !prefixLoading" description="暂无前缀 — 试试输入如 SIE. 后点击新增"
                        :image-size="56" />
                </div>
                <div style="display: flex; align-items: center; gap: 8px">
                    <el-input v-model="newPrefix" placeholder="新增前缀，如 SIE." clearable style="width: 260px"
                        @keyup.enter="onAddPrefix" />
                    <el-button type="primary" :loading="prefixAdding" @click="onAddPrefix">新增</el-button>
                </div>
            </el-card>
        </div>

        <!-- 底部按钮栏：保存 / 取消保存 -->
        <div class="settings-footer">
            <span v-if="isDirty" class="settings-tip settings-tip-unsaved">{{ $t('message.settings.unsavedTip')
                }}</span>
            <el-button :disabled="!isDirty" @click="onCancel">{{ $t('message.settings.cancel') }}</el-button>
            <el-button type="primary" :loading="saving" :disabled="!isDirty" @click="onSave">{{
                $t('message.settings.save')
                }}</el-button>
        </div>
    </div>
</template>

<script setup lang="ts" name="settings">
import { reactive, ref, onMounted, onUnmounted, computed } from "vue";
import { ElMessage, ElMessageBox, type FormInstance } from "element-plus";
import { useSettingsDb } from "@/database/settings/index";
import { useDiscoveryPrefixDb } from "@/database/discoveryPrefix/index";
import { defaultSettings, parsePublishModuleOrder, DEFAULT_PUBLISH_MODULE_ORDER } from "@/utils/publishSettings";
import { cmdInvoke } from "@/utils/command";
import mittBus from "@/utils/mitt";
import { listen } from "@tauri-apps/api/event";

const settingsDb = useSettingsDb();
const formRef = ref<FormInstance>();
const loading = ref(false);
const saving = ref(false);

const form = reactive<RowSettingsType>(defaultSettings());

// 发布顺序（设置页用上下按钮调整，保存时回写 form.publishModuleOrder）
const publishOrderList = ref<string[]>([...DEFAULT_PUBLISH_MODULE_ORDER]);
const moveOrder = (idx: number, dir: number) => {
    const target = idx + dir;
    if (target < 0 || target >= publishOrderList.value.length) return;
    const list = [...publishOrderList.value];
    [list[idx], list[target]] = [list[target], list[idx]];
    publishOrderList.value = list;
};

// 开机自启（状态以注册表为唯一真实源，切换立即生效，不落库）
const autoStartEnabled = ref(false);
const autoStartLoading = ref(false);

// MCP 配置
const mcpConfig = reactive({
    mcp_enabled: true,
    mcp_port: 17541,
});
const mcpStatus = ref<string>("unknown");
// 保存前的 MCP 配置快照（用于判断配置是否实际变化）
let mcpConfigSnapshot = { mcp_enabled: true, mcp_port: 17541 };
// 轮询计时器（加载/启用时轮询真实状态，避免依赖事件时序）
let mcpStatusTimer: number | null = null;
// 轮询代次令牌：stopMcpStatusPolling()/新轮询会递增，作废飞行中的旧轮询请求
let mcpPollToken = 0;

// ==================== 未保存状态跟踪 ====================
// 保存按钮仅在配置有改动后可用，并在旁边提示「当前配置未保存」，避免改完忘记保存。
// 表单与 MCP 配置分开记录快照：MCP 开关是即时保存的，不应把未保存的表单改动一并标记为已保存
const buildFormSnapshot = () =>
    JSON.stringify({
        oneClickPublishEnabled: form.oneClickPublishEnabled,
        winServiceRetryCount: form.winServiceRetryCount,
        winServiceRetryInterval: form.winServiceRetryInterval,
        winCopyRetryCount: form.winCopyRetryCount,
        winCopyRetryInterval: form.winCopyRetryInterval,
        uploadRetryCount: form.uploadRetryCount,
        uploadRetryInterval: form.uploadRetryInterval,
        winServiceStartTimeout: form.winServiceStartTimeout,
        winServiceStopTimeout: form.winServiceStopTimeout,
        publishModuleOrder: publishOrderList.value.join(","),
        sshMcpUrl: form.sshMcpUrl || "",
        sshMcpAutoSync: form.sshMcpAutoSync,
        startupMenu: form.startupMenu || "workstation",
    });
const buildMcpSnapshot = () => JSON.stringify({ mcp_enabled: mcpConfig.mcp_enabled, mcp_port: mcpConfig.mcp_port });
const savedFormSnapshot = ref(buildFormSnapshot());
const savedMcpSnapshot = ref(buildMcpSnapshot());
const isDirty = computed(
    () => savedFormSnapshot.value !== buildFormSnapshot() || savedMcpSnapshot.value !== buildMcpSnapshot()
);

let unlisten: (() => void) | null = null;

// 服务发现前缀管理
const discoveryPrefixDb = useDiscoveryPrefixDb();
const prefixList = ref<DiscoveryPrefix[]>([]);
const newPrefix = ref("");
const prefixLoading = ref(false);
const prefixAdding = ref(false);

const loadPrefixes = async () => {
    prefixLoading.value = true;
    try {
        await discoveryPrefixDb.seedDefaults();
        const r = await discoveryPrefixDb.getPrefixes();
        if (r.code === 0 && r.data) prefixList.value = r.data as DiscoveryPrefix[];
    } catch (e) {
        console.warn("加载发现前缀失败:", e);
    } finally {
        prefixLoading.value = false;
    }
};

const onAddPrefix = async () => {
    const val = newPrefix.value.trim();
    if (!val) {
        ElMessage.warning("请输入前缀");
        return;
    }
    if (prefixList.value.some((p) => p.prefix === val)) {
        ElMessage.warning("该前缀已存在");
        return;
    }
    prefixAdding.value = true;
    try {
        const r = await discoveryPrefixDb.upsertPrefix({ id: null, prefix: val, enabled: 1, isDefault: 0 });
        if (r.code === 0) {
            ElMessage.success("新增前缀成功");
            newPrefix.value = "";
            await loadPrefixes();
        } else {
            ElMessage.error(r.msg || "新增前缀失败");
        }
    } catch (e: any) {
        ElMessage.error("新增前缀失败: " + (e?.message || e));
    } finally {
        prefixAdding.value = false;
    }
};

const onTogglePrefixEnabled = async (row: DiscoveryPrefix) => {
    try {
        const r = await discoveryPrefixDb.upsertPrefix(row);
        if (r.code !== 0) {
            ElMessage.error(r.msg || "更新失败");
            await loadPrefixes();
        }
    } catch (e: any) {
        ElMessage.error("更新失败: " + (e?.message || e));
        await loadPrefixes();
    }
};

const onDeletePrefix = async (row: DiscoveryPrefix) => {
    if (row.isDefault === 1) {
        ElMessage.warning("默认前缀不可删除，可禁用");
        return;
    }
    try {
        await ElMessageBox.confirm(`确认删除前缀 “${row.prefix}”？`, "提示", {
            confirmButtonText: "确认",
            cancelButtonText: "取消",
            type: "warning",
        });
    } catch {
        return;
    }
    try {
        const r = await discoveryPrefixDb.deletePrefix(row.id as number);
        if (r.code === 0) {
            ElMessage.success("删除成功");
            await loadPrefixes();
        } else {
            ElMessage.error(r.msg || "删除失败");
        }
    } catch (e: any) {
        ElMessage.error("删除失败: " + (e?.message || e));
    }
};

// 监听 MCP 状态事件
onMounted(async () => {
    load();
    loadPrefixes();
    try {
        unlisten = await listen<{ status: string; message?: string; port?: number }>("mcp-status", (event) => {
            mcpStatus.value = event.payload.status;
            stopMcpStatusPolling();
        });
    } catch (e) {
        console.warn("监听 mcp-status 事件失败:", e);
    }
});

onUnmounted(() => {
    if (unlisten) unlisten();
    stopMcpStatusPolling();
});

// 轮询真实状态，直到获得确定状态（ok/error/disabled/stopped）或超时
const pollMcpStatus = async (timeoutMs: number = 8000) => {
    // 先作废旧轮询（令牌 + 计时器），再取本轮令牌
    stopMcpStatusPolling();
    const startedAt = Date.now();
    const token = mcpPollToken;
    mcpStatus.value = "starting";
    const tick = async () => {
        if (token !== mcpPollToken) return; // 已被停止/新轮询取代，作废
        const statusR = await cmdInvoke<string>("get_mcp_status");
        if (token !== mcpPollToken) return; // 请求期间被取代，丢弃结果
        const status = statusR.code === 0 && statusR.data ? statusR.data : "unknown";
        if (status !== "unknown") {
            mcpStatus.value = status;
            stopMcpStatusPolling();
            return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
            // 超时仍未获得真实状态：按配置回退，避免无限等待
            mcpStatus.value = mcpConfig.mcp_enabled ? "starting" : "disabled";
            stopMcpStatusPolling();
            return;
        }
        mcpStatusTimer = window.setTimeout(tick, 500);
    };
    mcpStatusTimer = window.setTimeout(tick, 0);
};

const stopMcpStatusPolling = () => {
    mcpPollToken++;
    if (mcpStatusTimer !== null) {
        clearTimeout(mcpStatusTimer);
        mcpStatusTimer = null;
    }
};

const mcpStatusTagType = computed(() => {
    switch (mcpStatus.value) {
        case "ok": return "success";
        case "error": return "danger";
        case "disabled": return "info";
        case "stopped": return "warning";
        case "starting": return "warning";
        default: return "info";
    }
});

const mcpStatusI18nKey = computed(() => {
    const key = mcpStatus.value;
    if (key === "ok") return "message.settings.mcpStatusOk";
    if (key === "error") return "message.settings.mcpStatusError";
    if (key === "disabled") return "message.settings.mcpStatusDisabled";
    if (key === "stopped") return "message.settings.mcpStatusStopped";
    if (key === "starting") return "message.settings.mcpStatusStarting";
    return "message.settings.mcpStatusDisabled";
});

const validate = (): boolean => {
    if (form.winServiceRetryCount < 1 || form.winServiceRetryCount > 99) {
        ElMessage.warning('重试次数需在 1-99 之间，间隔需在 1-60 之间');
        return false;
    }
    if (form.winServiceRetryInterval < 1 || form.winServiceRetryInterval > 60) return false;
    if (form.winCopyRetryCount < 1 || form.winCopyRetryCount > 99) return false;
    if (form.winCopyRetryInterval < 1 || form.winCopyRetryInterval > 60) return false;
    if (form.uploadRetryCount < 1 || form.uploadRetryCount > 99) return false;
    if (form.uploadRetryInterval < 1 || form.uploadRetryInterval > 60) return false;
    if (form.winServiceStartTimeout < 5 || form.winServiceStartTimeout > 300 || form.winServiceStopTimeout < 5 || form.winServiceStopTimeout > 300) {
        ElMessage.warning('启停等待超时需在 5-300 秒之间');
        return false;
    }
    if (publishOrderList.value.length !== DEFAULT_PUBLISH_MODULE_ORDER.length || !DEFAULT_PUBLISH_MODULE_ORDER.every((name) => publishOrderList.value.includes(name))) {
        ElMessage.warning('发布顺序必须包含全部模块且不重复');
        return false;
    }
    return true;
};

// 开机自启开关：立即写注册表，失败回滚开关状态
const onAutoStartChange = async (val: boolean) => {
    autoStartLoading.value = true;
    try {
        const r = await cmdInvoke<boolean>("set_auto_start", { enabled: val });
        if (r.code === 0) {
            autoStartEnabled.value = val;
            ElMessage.success(val ? '开机自启已开启' : '开机自启已关闭');
        } else {
            autoStartEnabled.value = !val;
            ElMessage.error('开机自启设置失败: ' + r.msg);
        }
    } catch (e) {
        autoStartEnabled.value = !val;
        ElMessage.error('开机自启设置失败: ' + e);
    } finally {
        autoStartLoading.value = false;
    }
};

const onMcpEnabledChange = async (val: boolean) => {
    // 立即保存并生效，不等保存按钮
    try {
        const r = await cmdInvoke<{ mcp_enabled: boolean; mcp_port: number }>("update_mcp_config", {
            mcpEnabled: val,
            mcpPort: mcpConfig.mcp_port,
        });
        if (r.code === 0 && r.data) {
            mcpConfig.mcp_enabled = r.data.mcp_enabled;
            mcpConfig.mcp_port = r.data.mcp_port;
            mcpConfigSnapshot = { ...mcpConfig };
            // MCP 配置已即时保存，仅刷新 MCP 快照（不吞掉未保存的表单改动）
            savedMcpSnapshot.value = buildMcpSnapshot();
            // 服务启停由 Rust 端异步执行，先同步占位状态，再轮询真实状态
            mcpStatus.value = val ? "starting" : "disabled";
            if (val) pollMcpStatus();
        } else {
            // 回滚开关状态
            mcpConfig.mcp_enabled = !val;
            ElMessage.error('MCP 启用状态保存失败: ' + r.msg);
        }
    } catch (e) {
        mcpConfig.mcp_enabled = !val;
        ElMessage.error('MCP 启用状态保存失败: ' + e);
    }
};

const onSave = async () => {
    if (!validate()) {
        ElMessage.warning('重试次数需在 1-99 之间，间隔需在 1-60 之间');
        return;
    }
    saving.value = true;
    form.publishModuleOrder = publishOrderList.value.join(',');
    const r = await settingsDb.saveSettings(form);
    if (r.code === 0) {
        // 保存 MCP 配置（端口变更时重启服务使新端口生效）
        const mcpR = await cmdInvoke<{ mcp_enabled: boolean; mcp_port: number }>("update_mcp_config", {
            mcpEnabled: mcpConfig.mcp_enabled,
            mcpPort: mcpConfig.mcp_port,
        });
        if (mcpR.code === 0 && mcpR.data) {
            const mcpChanged =
                mcpR.data.mcp_enabled !== mcpConfigSnapshot.mcp_enabled ||
                mcpR.data.mcp_port !== mcpConfigSnapshot.mcp_port;
            mcpConfig.mcp_enabled = mcpR.data.mcp_enabled;
            mcpConfig.mcp_port = mcpR.data.mcp_port;
            mcpConfigSnapshot = { ...mcpConfig };
            if (mcpChanged) {
                // 配置实际变化：服务启停/重启由 Rust 端异步执行，先同步占位状态，再轮询真实状态
                mcpStatus.value = mcpConfig.mcp_enabled ? "starting" : "disabled";
                if (mcpConfig.mcp_enabled) pollMcpStatus();
            }
            ElMessage.success('设置保存成功');
            mittBus.emit('settingsChanged');
        } else {
            ElMessage.warning('设置保存成功，但 MCP 配置保存失败: ' + mcpR.msg);
        }
        // 刷新已保存快照：表单已落库；MCP 仅在保存成功时刷新，失败则保持「未保存」提示便于重试
        savedFormSnapshot.value = buildFormSnapshot();
        if (mcpR.code === 0 && mcpR.data) savedMcpSnapshot.value = buildMcpSnapshot();
    } else {
        ElMessage.error(r.msg || '设置保存失败');
    }
    saving.value = false;
};

// 取消保存：丢弃未保存的修改，重新读取已保存的配置回显
const onCancel = async () => {
    if (!isDirty.value) return;
    await load();
    ElMessage.info("已恢复为已保存的配置");
};

const load = async () => {
    loading.value = true;
    // 加载业务设置
    const r = await settingsDb.getSettings();
    if (r.code === 0 && r.data) Object.assign(form, r.data);
    publishOrderList.value = parsePublishModuleOrder(form.publishModuleOrder);
    // 加载开机自启状态（以注册表实际状态回显，与系统保持一致）
    const autoR = await cmdInvoke<boolean>("get_auto_start");
    if (autoR.code === 0) autoStartEnabled.value = !!autoR.data;
    // 加载 MCP 配置
    const mcpR = await cmdInvoke<{ mcp_enabled: boolean; mcp_port: number }>("get_mcp_config");
    if (mcpR.code === 0 && mcpR.data) {
        mcpConfig.mcp_enabled = mcpR.data.mcp_enabled;
        mcpConfig.mcp_port = mcpR.data.mcp_port;
        mcpConfigSnapshot = { ...mcpConfig };
    }
    // 加载 MCP 运行状态（mcp-status 事件在启动时已发射，页面挂载后可能收不到）
    // 轮询真实状态；若为 unknown（服务仍在启动）则显示"启动中"并在超时后按配置回退
    await pollMcpStatus();
    // 记录加载完成时的状态快照：此时无改动，保存按钮置灰
    savedFormSnapshot.value = buildFormSnapshot();
    savedMcpSnapshot.value = buildMcpSnapshot();
    loading.value = false;
};
</script>

<style scoped lang="scss">
.settings-container {
    display: flex;
    flex-direction: column;
    overflow: hidden;

    .settings-tip {
        margin-left: 10px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
    }

    .settings-tip-unsaved {
        color: var(--el-color-warning);
    }

    // 页面高度固定填满：上为配置内容（纵向溢出自动滚动），下为常驻按钮栏
    .settings-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding-right: 4px;
    }

    // 按钮靠右：未保存提示靠左（margin-right: auto 占满剩余空间），按钮组贴右
    .settings-footer {
        flex: none;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        margin-top: 4px;
        margin-right: 12px;

        .settings-tip-unsaved {
            margin-right: 1rem;
        }
    }

    .prefix-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
    }

    .prefix-tag-row {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 4px 6px;
        border: 1px solid var(--el-border-color-lighter);
        border-radius: 6px;
        background: var(--el-fill-color-light);
    }

    .order-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .order-item {
        display: inline-flex;
        align-items: center;
        gap: 8px;

        .order-idx {
            width: 20px;
            text-align: center;
            color: var(--el-text-color-secondary);
            font-size: 12px;
        }

        .order-name {
            min-width: 120px;
            font-size: 13px;
        }
    }
}
</style>
