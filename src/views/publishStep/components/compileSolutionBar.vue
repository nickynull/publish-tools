<template>
    <div class="project-compile-block">
        <!-- 行1：label + 路径 + 选择/清除；路径来自应用配置，调整后实时落库（t_app_config.solution_path） -->
        <div class="project-select-row project-compile-row">
            <div class="project-select-label compile-label">
                <el-tooltip placement="top" effect="dark"
                    content="用 MSBuild 一次编译整个解决方案（.sln），替代逐个服务项目编译；点顶部【编译解决方案】执行">
                    <span class="compile-label-text">解决方案</span>
                </el-tooltip>
            </div>
            <div class="compile-box">
                <a v-if="solutionPath" class="compile-path" href="javascript:void(0);"
                    :title="`打开解决方案所在目录：${solutionDir}`" @click="onOpenSolutionDir">{{
                    solutionPath }}</a>
                <span v-else class="compile-empty">未关联（点【选择】指定 .sln 文件，保存到应用配置）</span>
                <el-button size="small" :icon="FolderOpened" :disabled="disabled" title="选择解决方案文件（.sln）"
                    @click="onSelectSolution">选择</el-button>
                <el-button v-if="solutionPath" size="small" type="info" :icon="Delete" text
                    :disabled="disabled" title="清除应用配置中的解决方案路径" @click="onClearSolution" />
            </div>
        </div>
        <!-- 行2：编译配置（生成模式 / 平台 / 方式）收进一个下拉面板，按 项目 + 环境 记忆在本机 -->
        <div class="project-select-row project-compile-row compile-config-row">
            <div class="project-select-label compile-label">
                <el-tooltip placement="top" effect="dark"
                    content="MSBuild 编译参数：生成模式对应 /p:Configuration，平台对应 /p:Platform（需与解决方案配置中的平台一致）">
                    <span class="compile-label-text">编译配置</span>
                </el-tooltip>
            </div>
            <el-popover placement="bottom-start" :width="280" trigger="click">
                <template #reference>
                    <el-button size="small" :disabled="disabled" class="compile-config-btn">
                        <el-icon class="compile-config-icon"><ele-Setting /></el-icon>
                        编译配置
                    </el-button>
                </template>
                <div class="compile-config-form">
                    <div class="compile-config-item">
                        <span class="compile-config-label">生成模式</span>
                        <el-select v-model="buildMode" size="small" :disabled="disabled" class="compile-select"
                            title="生成模式（对应 MSBuild /p:Configuration）">
                            <el-option v-for="mode in stepCompileBuildModes" :key="mode" :label="mode" :value="mode" />
                        </el-select>
                    </div>
                    <div class="compile-config-item">
                        <span class="compile-config-label">平台</span>
                        <el-select v-model="platform" size="small" :disabled="disabled" class="compile-select"
                            title="平台（对应 MSBuild /p:Platform，需与解决方案配置中的平台一致）">
                            <el-option v-for="item in stepCompilePlatforms" :key="item" :label="item" :value="item" />
                        </el-select>
                    </div>
                    <div class="compile-config-item">
                        <span class="compile-config-label">方式</span>
                        <el-switch :model-value="isRebuild" :disabled="disabled" size="small" inline-prompt
                            active-text="重新生成" inactive-text="增量生成"
                            :title="isRebuild ? '重新生成（Rebuild）：先清理再编译，耗时更长' : '增量生成（Build）：只编译有变化的项目'"
                            @change="(value: boolean | string | number) => onRebuildChange(Boolean(value))" />
                    </div>
                </div>
            </el-popover>
            <!-- 拉取最新代码：控制编译解决方案前是否先获取一遍最新代码（存应用配置，实时落库） -->
            <el-tooltip placement="top" effect="dark"
                content="开启后，发布编译前会先按应用配置的获取方式获取一遍最新代码：本页【编译解决方案】与主页【一键发布】均生效；直接点【获取最新代码】按钮不受此开关控制">
                <span class="pull-latest-item">
                    <span class="compile-config-item-label">拉取最新代码</span>
                    <el-switch :model-value="pullLatest" size="small"
                        :disabled="disabled || !pullLatestAvailable"
                        @change="(value: boolean | string | number) => emit('change-pull-latest', Boolean(value))" />
                </span>
            </el-tooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElMessage } from "element-plus";
import { open } from "@tauri-apps/plugin-dialog";
import { Delete, FolderOpened } from "@element-plus/icons-vue";
import { cmdInvoke } from "@/utils/command";
import {
    stepCompileBuildModes,
    stepCompilePlatforms,
    type StepCompileConfig,
} from "@/composables/useStepCompile";

/**
 * 发布信息卡：编译解决方案配置块
 * - 解决方案路径来自应用配置（props.solutionPath，由页面落库），选择/清除通过 change-solution 事件交回页面；
 * - 生成模式 / 平台 / 方式等编译参数读写通过 change 事件交回页面（单一数据源在 useStepCompile，存本机）；
 * - 「拉取最新代码」开关由页面单向传入（props.pullLatest），变更经 change-pull-latest 交回页面落库
 */
const props = defineProps<{
    solutionPath: string;
    config: StepCompileConfig;
    disabled?: boolean;
    /** 拉取最新代码开关（应用配置 configItems.isPullLatest） */
    pullLatest?: boolean;
    /** 是否取到应用配置（开关可用前提） */
    pullLatestAvailable?: boolean;
}>();

const emit = defineEmits<{
    (e: "change", patch: Partial<StepCompileConfig>): void;
    (e: "change-solution", solutionPath: string | null): void;
    (e: "change-pull-latest", value: boolean): void;
}>();

const emitChange = (patch: Partial<StepCompileConfig>) => {
    emit("change", patch);
};

// 生成模式 / 平台 / 方式：写成可写 computed，变更即抛给页面落盘
const buildMode = computed({
    get: () => props.config.buildMode || "Release",
    set: (value: string) => emitChange({ buildMode: value }),
});
const platform = computed({
    get: () => props.config.platform ?? "Any CPU",
    set: (value: string) => emitChange({ platform: value }),
});
const isRebuild = computed(() => !!props.config.isRebuild);
const onRebuildChange = (value: boolean) => {
    emitChange({ isRebuild: value });
};

// 解决方案所在目录（点路径可打开）
const solutionDir = computed(() => String(props.solutionPath || "").replace(/[\\/][^\\/]*$/, ""));

// 选择解决方案文件（选择后由页面实时落库到应用配置）
const onSelectSolution = async () => {
    try {
        const file = await open({
            multiple: false,
            title: "选择解决方案文件",
            filters: [{ name: "解决方案", extensions: ["sln"] }],
        });
        if (!file) return;
        const solutionPath = String(file).replace(/\//g, "\\");
        emit("change-solution", solutionPath);
    } catch (error) {
        console.error("打开解决方案选择框失败:", error);
        ElMessage.error("打开解决方案选择框失败");
    }
};

// 清除应用配置中的解决方案路径
const onClearSolution = () => {
    if (!props.solutionPath) return;
    emit("change-solution", null);
};

// 打开解决方案所在目录
const onOpenSolutionDir = async () => {
    if (!solutionDir.value) return;
    await cmdInvoke("open_dir", { path: solutionDir.value });
};
</script>

<style scoped lang="scss">
.project-compile-block {
    font-weight: 600;

    // 本组件内的 .project-select-row 不受页面 scoped 的 display:flex 影响（scoped 穿不透子组件），需自带布局
    .project-compile-row {
        display: flex;
        align-items: center;
        gap: 0.2rem;
        flex-wrap: nowrap;
    }

    .compile-label {
        flex: 0 0 6rem;
        text-align: right;
        white-space: nowrap;
    }

    .compile-label-text {
        border-bottom: 1px dashed var(--el-border-color);
        cursor: help;
    }

    .compile-box {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 0.4rem;
        min-width: 0;
    }

    .compile-path {
        flex: 1;
        min-width: 0;
        // 溢出换行显示（Windows 路径无空格，按字符断行）
        word-break: break-all;
        color: var(--el-text-color-primary);

        &:hover {
            color: var(--el-color-primary);
            background-color: var(--el-bg-color);
            cursor: pointer;
        }
    }

    .compile-empty {
        flex: 1;
        min-width: 0;
        color: var(--el-text-color-secondary);
        font-size: 0.85rem;
    }

    // 编译配置行：单个下拉按钮 + 拉取最新代码开关
    .compile-config-btn {
        font-weight: 600;

        .compile-config-icon {
            margin-right: 4px;
        }
    }

    .pull-latest-item {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        margin-left: 0.4rem;
        cursor: help;
    }

    .compile-config-item-label {
        color: var(--el-text-color-regular);
        font-weight: 400;
        white-space: nowrap;
        cursor: help;
    }

    :deep(.el-button + .el-button) {
        margin-left: 0;
    }
}
</style>

<style lang="scss">
// 编译配置弹层内容（popover 挂在 body 下，需全局样式）
.compile-config-form {
    display: flex;
    flex-direction: column;
    gap: 10px;

    .compile-config-item {
        display: flex;
        align-items: center;
        gap: 8px;

        .compile-config-label {
            flex: 0 0 60px;
            text-align: right;
            color: var(--el-text-color-regular);
        }

        .compile-select {
            flex: 1;
        }
    }
}
</style>
