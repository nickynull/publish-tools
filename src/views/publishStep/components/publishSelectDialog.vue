<template>
    <!-- 发布前勾选服务（勾选发布模式）：默认全选，只发布勾选的服务 -->
    <el-dialog v-model="visible" title="选择要发布的服务" width="880px" draggable class="publish-pick-dialog"
        @closed="onClosed">
        <!-- 备份提醒与流程说明并入本弹窗（勾选发布模式下不再单独弹确认框） -->
        <el-alert class="pick-alert" type="warning" :closable="false" show-icon :title="tipText" />
        <div class="pick-bar">
            <el-checkbox :model-value="allChecked" :indeterminate="partlyChecked" @change="onToggleAll">
                全选
            </el-checkbox>
            <span class="pick-tip">
                共 {{ instanceCount }} 个服务，已选 {{ selectedKeys.size }} 个；未勾选的服务不会被停止、替换或启动
            </span>
        </div>
        <div class="pick-groups">
            <div class="pick-group" v-for="group in groups" :key="group.serverId">
                <div class="pick-group-head">
                    <el-checkbox :model-value="group.checked" :indeterminate="group.indeterminate"
                        @change="(value: boolean | string | number) => onToggleGroup(group.serverId, Boolean(value))" />
                    <span class="pick-group-title">{{ group.serverName }}</span>
                    <span class="pick-group-extra">{{ group.checkedCount }}/{{ group.rows.length }} 个服务</span>
                </div>
                <div class="pick-row" v-for="row in group.rows" :key="row.key">
                    <el-checkbox :model-value="selectedKeys.has(row.key)"
                        @change="(value: boolean | string | number) => onToggleRow(row.key, Boolean(value))" />
                    <span class="pick-row-module">{{ row.module }}</span>
                    <span class="pick-row-identity">{{ row.identity || "无服务标识（仅替换文件）" }}</span>
                    <span class="pick-row-path" :title="row.path">{{ row.path }}</span>
                </div>
            </div>
        </div>
        <template #footer>
            <el-button @click="onCancel">取消</el-button>
            <el-button type="primary" :disabled="selectedKeys.size < 1" @click="onConfirm">
                开始发布（{{ selectedKeys.size }}）
            </el-button>
        </template>
    </el-dialog>
</template>

<script setup lang="ts" name="publishStepPickDialog">
import { ref, computed } from "vue";
import type { ServiceInstanceType } from "@/composables/useStepPublish";

// 列表行：与发布实例一一对应（同一服务被多模块引用时按模块区分）
type PickRow = ServiceInstanceType & { key: string };
// 触发来源（决定顶部提示文案）
type PickMode = "publish" | "oneClick";
type PickGroup = {
    serverId: number;
    serverName: string;
    rows: PickRow[];
    checked: boolean;
    indeterminate: boolean;
    checkedCount: number;
};

const visible = ref(false);
const rows = ref<PickRow[]>([]);
const selectedKeys = ref<Set<string>>(new Set());
// 触发来源：publish 单独发布 / oneClick 一键发布（决定顶部提示文案）
const tipMode = ref<PickMode>("publish");
// 确定/取消的结果回调（open 返回 Promise）
let resolver: ((value: ServiceInstanceType[] | null) => void) | null = null;

const tipText = computed(() =>
    tipMode.value === "oneClick"
        ? "一键发布将依次执行：获取程序集 → 打包WPF（不发布WPF时自动跳过） → 上传程序集 → 发布，任一步失败即中止。建议发布前先执行【更多功能 → 备份】；下面勾选的是最后发布步骤要处理的服务。"
        : "发布前建议先执行【更多功能 → 备份】：将按勾选的服务逐个执行 停止服务 → 用程序集暂存路径的内容替换服务发布路径 → 开启服务；未勾选的服务不会被停止、替换或启动。"
);

const rowKey = (ins: ServiceInstanceType) => `${ins.serverId}|${ins.module}|${ins.identity}|${ins.path}`;

const instanceCount = computed(() => rows.value.length);

// 按服务器分组（服务器顺序取实例首次出现顺序，组内保持传入顺序）
const groups = computed<PickGroup[]>(() => {
    const groupMap = new Map<number, PickGroup>();
    for (const row of rows.value) {
        let group = groupMap.get(row.serverId);
        if (!group) {
            group = {
                serverId: row.serverId,
                serverName: row.serverName,
                rows: [],
                checked: false,
                indeterminate: false,
                checkedCount: 0,
            };
            groupMap.set(row.serverId, group);
        }
        group.rows.push(row);
    }
    const list = [...groupMap.values()];
    for (const group of list) {
        group.checkedCount = group.rows.filter((row) => selectedKeys.value.has(row.key)).length;
        group.checked = group.checkedCount === group.rows.length && group.rows.length > 0;
        group.indeterminate = group.checkedCount > 0 && group.checkedCount < group.rows.length;
    }
    return list;
});

const allChecked = computed(() => rows.value.length > 0 && selectedKeys.value.size === rows.value.length);
const partlyChecked = computed(() => selectedKeys.value.size > 0 && selectedKeys.value.size < rows.value.length);

// 勾选变化：直接替换 Set，保证 computed 重新求值
const setSelected = (keys: string[]) => {
    selectedKeys.value = new Set(keys);
};

const onToggleAll = (value: boolean | string | number) => {
    setSelected(Boolean(value) ? rows.value.map((row) => row.key) : []);
};

const onToggleGroup = (serverId: number, value: boolean) => {
    const keys = new Set(selectedKeys.value);
    for (const row of rows.value) {
        if (row.serverId !== serverId) continue;
        if (value) keys.add(row.key);
        else keys.delete(row.key);
    }
    selectedKeys.value = keys;
};

const onToggleRow = (key: string, value: boolean) => {
    const keys = new Set(selectedKeys.value);
    if (value) keys.add(key);
    else keys.delete(key);
    selectedKeys.value = keys;
};

const onConfirm = () => {
    const picked = rows.value
        .filter((row) => selectedKeys.value.has(row.key))
        .map((row) => ({
            module: row.module,
            serverId: row.serverId,
            serverName: row.serverName,
            identity: row.identity,
            path: row.path,
        }));
    finish(picked);
};

const onCancel = () => {
    finish(null);
};

const finish = (result: ServiceInstanceType[] | null) => {
    const done = resolver;
    resolver = null;
    visible.value = false;
    done?.(result);
};

// 弹窗关闭（含右上角 ×）：未走确定/取消时按取消处理
const onClosed = () => {
    if (resolver) finish(null);
};

/**
 * 打开选择框：默认全选，返回勾选的服务实例；取消/关闭返回 null
 * @param mode 触发来源，决定顶部提示（发布 / 一键发布）
 */
const open = (instances: ServiceInstanceType[], mode: PickMode = "publish"): Promise<ServiceInstanceType[] | null> => {
    // 上一次未结算的调用先按取消处理，避免 Promise 悬挂
    if (resolver) finish(null);
    tipMode.value = mode;
    rows.value = instances.map((ins) => ({ ...ins, key: rowKey(ins) }));
    selectedKeys.value = new Set(rows.value.map((row) => row.key));
    visible.value = true;
    return new Promise((resolve) => {
        resolver = resolve;
    });
};

defineExpose({ open });
</script>

<style lang="scss" scoped>
.pick-alert {
    margin-bottom: 10px;
}

.pick-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-bottom: 8px;

    .pick-tip {
        font-size: 12px;
        color: var(--el-text-color-secondary);
    }
}

.pick-groups {
    max-height: 52vh;
    overflow-y: auto;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 4px;

    .pick-group + .pick-group {
        border-top: 1px solid var(--el-border-color-lighter);
    }

    .pick-group-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: var(--el-fill-color-light);

        .pick-group-title {
            font-weight: 600;
        }

        .pick-group-extra {
            font-size: 12px;
            color: var(--el-text-color-secondary);
        }
    }

    .pick-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 4px 10px 4px 34px;
        font-size: 13px;

        &:hover {
            background: var(--el-fill-color-lighter);
        }

        .pick-row-module {
            min-width: 110px;
            font-weight: 500;
        }

        .pick-row-identity {
            min-width: 150px;
            color: var(--el-text-color-regular);
        }

        .pick-row-path {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            color: var(--el-text-color-secondary);
        }
    }
}
</style>
