<template>
    <div class="layout-padding">
        <div class="icons-container">
            <!-- 预览设置 -->
            <el-card shadow="never" class="icons-card">
                <template #header>
                    <div class="icons-card-header">
                        <span>{{ $t('message.icons.previewTitle') }}</span>
                        <span class="icons-card-tip">{{ $t('message.icons.previewTip') }}</span>
                    </div>
                </template>
                <div class="icons-toolbar">
                    <el-input v-model="state.search" :placeholder="$t('message.icons.searchPlaceholder')" clearable
                        style="width: 320px">
                        <template #prefix>
                            <el-icon>
                                <Search />
                            </el-icon>
                        </template>
                    </el-input>

                    <div class="icons-toolbar-item">
                        <span class="icons-toolbar-label">{{ $t('message.icons.size') }}</span>
                        <el-slider v-model="state.size" :min="12" :max="64" :step="2" style="width: 180px" />
                        <span class="icons-toolbar-value">{{ state.size }}px</span>
                    </div>

                    <div class="icons-toolbar-item">
                        <span class="icons-toolbar-label">{{ $t('message.icons.color') }}</span>
                        <el-select v-model="state.color" style="width: 200px">
                            <el-option v-for="c in colorList" :key="c.key" :label="c.label" :value="c.value">
                                <span class="icons-option">
                                    <i class="icons-dot" :style="{ background: c.value || 'currentColor' }" />
                                    <span>{{ c.label }}</span>
                                    <span class="icons-option-value">{{ c.value || 'inherit' }}</span>
                                </span>
                            </el-option>
                        </el-select>
                    </div>

                    <div class="icons-toolbar-item">
                        <span class="icons-toolbar-label">{{ $t('message.icons.copyFormat') }}</span>
                        <el-radio-group v-model="state.copyFormat">
                            <el-radio-button value="component">{{ $t('message.icons.copyComponent') }}</el-radio-button>
                            <el-radio-button value="name">{{ $t('message.icons.copyName') }}</el-radio-button>
                            <el-radio-button value="route">{{ $t('message.icons.copyRoute') }}</el-radio-button>
                        </el-radio-group>
                    </div>
                </div>
            </el-card>

            <!-- 图标库 -->
            <el-card shadow="never" class="icons-card" v-loading="state.loading">
                <template #header>
                    <div class="icons-card-header">
                        <span>{{ $t('message.icons.libTitle') }}</span>
                        <span class="icons-card-tip">{{ $t('message.icons.libTip') }}</span>
                    </div>
                </template>

                <el-tabs v-model="state.activeTab" @tab-change="onTabChange">
                    <el-tab-pane v-for="lib in libList" :key="lib.key" :name="lib.key">
                        <template #label>
                            <span class="icons-tab-label">
                                <span>{{ lib.label }}</span>
                                <span class="icons-tab-count">{{ matchCount(lib.key) }}</span>
                            </span>
                        </template>
                    </el-tab-pane>
                </el-tabs>

                <div class="icons-grid" v-if="visibleList.length > 0">
                    <div v-for="item in visibleList" :key="item" class="icons-item"
                        :class="{ 'is-active': item === state.selected }" :title="item" @click="onCopyIcon(item)">
                        <div class="icons-item-icon">
                            <SvgIcon :name="item" :size="state.size" :color="state.color" />
                        </div>
                        <div class="icons-item-name" v-html="highlight(item)"></div>
                    </div>
                </div>

                <el-empty v-else :image-size="80">
                    <template #description>
                        <div>{{ $t('message.icons.noMatch') }}</div>
                        <div class="icons-empty-tip">{{ $t('message.icons.noMatchTip') }}</div>
                    </template>
                </el-empty>

                <div class="icons-footer">
                    <span class="icons-count">{{ showingText }}</span>
                    <el-button v-if="visibleList.length < filteredList.length" link type="primary" @click="onLoadMore">
                        {{ $t('message.icons.loadMore') }}
                    </el-button>
                </div>
            </el-card>

            <!-- 颜色 -->
            <el-card shadow="never" class="icons-card">
                <template #header>
                    <div class="icons-card-header">
                        <span>{{ $t('message.icons.colorTitle') }}</span>
                        <span class="icons-card-tip">{{ $t('message.icons.colorTip') }}</span>
                    </div>
                </template>
                <div class="icons-colors">
                    <div v-for="c in colorList" :key="c.key" class="icons-color"
                        :class="{ 'is-active': state.color === c.value }" @click="state.color = c.value">
                        <span class="icons-color-dot" :style="{ background: c.value || 'currentColor' }" />
                        <div class="icons-color-meta">
                            <div class="icons-color-name">{{ c.label }}</div>
                            <div class="icons-color-value">{{ c.value || 'inherit' }}</div>
                            <div class="icons-color-hex">{{ c.hex || '&nbsp;' }}</div>
                        </div>
                    </div>
                </div>
            </el-card>

            <!-- 用法 -->
            <el-card shadow="never" class="icons-card">
                <template #header>
                    <div class="icons-card-header">
                        <span>{{ $t('message.icons.usageTitle') }}</span>
                        <span class="icons-card-tip">{{ $t('message.icons.usageTip') }}</span>
                    </div>
                </template>

                <el-divider content-position="left">{{ $t('message.icons.propTableTitle') }}</el-divider>
                <el-table :data="propRows" border size="small" style="width: 100%">
                    <el-table-column prop="name" :label="$t('message.icons.propName')" width="120" />
                    <el-table-column prop="desc" :label="$t('message.icons.propDesc')" min-width="260" />
                    <el-table-column prop="type" :label="$t('message.icons.propType')" width="90" />
                    <el-table-column prop="default" :label="$t('message.icons.propDefault')" width="90" />
                </el-table>

                <el-divider content-position="left">{{ $t('message.icons.sampleTitle') }}</el-divider>
                <div class="icons-samples">
                    <div v-for="s in usageSamples" :key="s.title" class="icons-sample">
                        <div class="icons-sample-head">
                            <span class="icons-sample-title">{{ s.title }}</span>
                            <el-button link type="primary" @click="copyText(s.code)">{{ $t('message.icons.copy')
                                }}</el-button>
                        </div>
                        <div class="icons-sample-desc">{{ s.desc }}</div>
                        <pre class="icons-code"><code>{{ s.code }}</code></pre>
                    </div>
                </div>

                <el-divider content-position="left">{{ $t('message.icons.noteTitle') }}</el-divider>
                <ul class="icons-notes">
                    <li v-for="(n, i) in notes" :key="i">{{ n }}</li>
                </ul>
            </el-card>
        </div>
    </div>
</template>

<script setup lang="ts" name="icons">
import { computed, defineAsyncComponent, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Search } from "@element-plus/icons-vue";
import initIconfont from "@/utils/getStyleSheets";
import commonFunction from "@/utils/commonFunction";

const SvgIcon = defineAsyncComponent(() => import("@/components/svgIcon/index.vue"));

const { t } = useI18n();
const { copyText } = commonFunction();

// 图标库定义：key 与 initIconfont 的方法名一致
const libList = [
    { key: "ali", label: "smom-icon", prefix: "smom-icon" },
    { key: "ele", label: "ele- (Element Plus)", prefix: "ele-" },
    { key: "awe", label: "fa (FontAwesome)", prefix: "fa-" },
] as const;

type LibKey = (typeof libList)[number]["key"];

// 支持的颜色（Element Plus 语义色 + 文字色），value 可直接用于 SvgIcon 的 color
const colorList = [
    { key: "default", label: "默认（继承文本色）", value: "", hex: "" },
    { key: "primary", label: "primary", value: "var(--el-color-primary)", hex: "#409eff" },
    { key: "success", label: "success", value: "var(--el-color-success)", hex: "#67c23a" },
    { key: "warning", label: "warning", value: "var(--el-color-warning)", hex: "#e6a23c" },
    { key: "danger", label: "danger", value: "var(--el-color-danger)", hex: "#f56c6c" },
    { key: "error", label: "error", value: "var(--el-color-error)", hex: "#f56c6c" },
    { key: "info", label: "info", value: "var(--el-color-info)", hex: "#909399" },
    { key: "textPrimary", label: "主要文字", value: "var(--el-text-color-primary)", hex: "#303133" },
    { key: "textRegular", label: "常规文字", value: "var(--el-text-color-regular)", hex: "#606266" },
    { key: "textSecondary", label: "次要文字", value: "var(--el-text-color-secondary)", hex: "#909399" },
    { key: "textPlaceholder", label: "占位文字", value: "var(--el-text-color-placeholder)", hex: "#c0c4cc" },
];

// 每页渲染数量，避免 FontAwesome 近 800 个图标一次性渲染卡顿
const PAGE_SIZE = 120;

const state = reactive({
    search: "",
    activeTab: "ali" as LibKey,
    size: 24,
    color: "",
    copyFormat: "component" as "component" | "name" | "route",
    selected: "",
    list: { ali: [] as string[], ele: [] as string[], awe: [] as string[] },
    loading: false,
});

const visibleCount = ref(PAGE_SIZE);

// 搜索关键词（去空格、转小写）
const keyword = computed(() => state.search.trim().toLowerCase());

// 按库过滤后的图标列表
const filterBy = (key: LibKey) => {
    const list = state.list[key];
    const kw = keyword.value;
    if (!kw) return list;
    return list.filter((i) => i.toLowerCase().indexOf(kw) > -1);
};
const filteredList = computed(() => filterBy(state.activeTab));
const visibleList = computed(() => filteredList.value.slice(0, visibleCount.value));

// tab 上的数量角标：搜索时显示匹配数，否则显示总数
const matchCount = (key: LibKey) => filterBy(key).length;

// 已显示 / 总数文案
const showingText = computed(() =>
    t("message.icons.showing", {
        shown: visibleList.value.length,
        total: filteredList.value.length,
    })
);

// 格式化图标名：去掉库前缀后剩余的可读名（用于展示时保持一致，此处仍展示完整 name）
const highlight = (name: string) => {
    const kw = keyword.value;
    const text = escapeHtml(name);
    if (!kw) return text;
    const idx = name.toLowerCase().indexOf(kw);
    if (idx < 0) return text;
    return (
        escapeHtml(name.slice(0, idx)) +
        '<em class="icons-hit">' +
        escapeHtml(name.slice(idx, idx + kw.length)) +
        "</em>" +
        escapeHtml(name.slice(idx + kw.length))
    );
};
const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 生成待复制的用法文本
const buildUsage = (name: string) => {
    if (state.copyFormat === "name") return name;
    if (state.copyFormat === "route") return `icon: '${name}'`;
    const colorAttr = state.color ? ` color="${state.color}"` : "";
    return `<SvgIcon name="${name}" :size="${state.size}"${colorAttr} />`;
};
const onCopyIcon = (name: string) => {
    state.selected = name;
    copyText(buildUsage(name));
};

// 切换图标库 / 搜索变化时重置分页
const onTabChange = () => {
    visibleCount.value = PAGE_SIZE;
};
const onLoadMore = () => {
    visibleCount.value += PAGE_SIZE;
};

// 加载图标名。ali/awe 依赖 document.styleSheets 中的字库 CSS（App.vue 动态注入），
// 首帧可能未就绪，故失败时重试若干次
const loadLib = async (key: LibKey) => {
    if (state.list[key].length > 0) return;
    const retry = 3;
    for (let i = 0; i < retry; i++) {
        try {
            const res: any = await (initIconfont as any)[key]();
            const names: string[] = Array.isArray(res) ? res : [];
            if (names.length === 0) throw new Error("empty");
            // ali: `smom-icon smom-icon-xxx`，awe: `fa fa-xxx`，ele: 自身已带 `ele-` 前缀
            state.list[key] = key === "ele" ? names : names.map((n) => `${key === "ali" ? "smom-icon" : "fa"} ${n}`);
            return;
        } catch (e) {
            if (i === retry - 1) {
                state.list[key] = [];
                console.warn(`[icons] 加载图标库 ${key} 失败:`, e);
            } else {
                await new Promise((r) => setTimeout(r, 300));
            }
        }
    }
};

onMounted(async () => {
    state.loading = true;
    try {
        // 三个库一并加载，便于在 tab 上展示各自的匹配数量
        await Promise.all(libList.map((l) => loadLib(l.key)));
    } finally {
        state.loading = false;
    }
});

// SvgIcon 属性说明
const propRows = [
    {
        name: "name",
        desc: "图标名。smom-icon：`smom-icon smom-icon-xxx`；Element Plus：`ele-XXX`；FontAwesome：`fa fa-xxx`；也支持 http(s) 在线图片与本地图片路径",
        type: "string",
        default: "—",
    },
    { name: "size", desc: "图标尺寸（px），同时作用于宽高与字号", type: "number", default: "14" },
    {
        name: "color",
        desc: "图标颜色，支持 CSS 变量（如 var(--el-color-primary)）与任意色值；不传则继承所在文本颜色",
        type: "string",
        default: "—",
    },
];

// 用法示例（跟随当前预览尺寸与颜色）
const usageSamples = computed(() => {
    const colorAttr = state.color ? ` color="${state.color}"` : "";
    return [
        {
            title: "smom-icon（本项目图标库）",
            desc: "阿里 iconfont 字库，name 需带 `smom-icon` 基类名",
            code: `<SvgIcon name="smom-icon smom-icon-fabu" :size="${state.size}"${colorAttr} />`,
        },
        {
            title: "ele-（Element Plus）",
            desc: "Element Plus 自带 SVG 图标，name 为 `ele-` + 组件名",
            code: `<SvgIcon name="ele-MagicStick" :size="${state.size}"${colorAttr} />`,
        },
        {
            title: "fa（FontAwesome 4.7）",
            desc: "FontAwesome 字库，name 需带 `fa` 基类名",
            code: `<SvgIcon name="fa fa-home" :size="${state.size}"${colorAttr} />`,
        },
        {
            title: "图片 / 在线链接",
            desc: "name 为 http(s) 或本地路径时按图片渲染，color 通过 drop-shadow 着色",
            code: `<SvgIcon name="/static/logo.png" :size="${state.size}"${colorAttr} />`,
        },
        {
            title: "菜单路由配置",
            desc: "在 src/router/route.ts 的 meta.icon 中直接写图标名",
            code: `meta: {\n  title: 'message.router.icons',\n  icon: 'smom-icon smom-icon-fabu',\n}`,
        },
        {
            title: "图标选择器组件",
            desc: "需要让用户自选图标时使用 IconSelector，支持搜索且自动分类三个图标库",
            code: `<IconSelector v-model="form.icon" :prepend="form.icon" :size="'default'" />`,
        },
    ];
});

// 补充说明
const notes = computed(() => [
    t("message.icons.note1"),
    t("message.icons.note2"),
    t("message.icons.note3"),
    t("message.icons.note4"),
]);
</script>

<style scoped lang="scss">
.icons-container {
    flex: 1;
    overflow: auto;

    .icons-card {
        margin-bottom: 15px;
    }

    .icons-card-header {
        display: flex;
        align-items: baseline;
        gap: 10px;
    }

    .icons-card-tip {
        font-size: 12px;
        color: var(--el-text-color-secondary);
    }
}

.icons-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 18px;

    .icons-toolbar-item {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .icons-toolbar-label {
        font-size: 13px;
        color: var(--el-text-color-regular);
        white-space: nowrap;
    }

    .icons-toolbar-value {
        font-size: 12px;
        color: var(--el-text-color-secondary);
        width: 34px;
    }
}

.icons-option {
    display: flex;
    align-items: center;
    gap: 8px;

    .icons-option-value {
        margin-left: auto;
        font-size: 12px;
        color: var(--el-text-color-secondary);
    }
}

.icons-dot {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1px solid var(--el-border-color);
}

.icons-tab-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;

    .icons-tab-count {
        font-size: 12px;
        color: var(--el-text-color-secondary);
        background: var(--el-fill-color-light);
        border-radius: 8px;
        padding: 0 6px;
        line-height: 16px;
    }
}

.icons-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
    gap: 10px;
}

.icons-item {
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 6px;
    padding: 10px 6px 8px;
    text-align: center;
    cursor: pointer;
    overflow: hidden;
    transition: all 0.2s;

    &:hover {
        border-color: var(--el-color-primary-light-5);
        background-color: var(--el-color-primary-light-9);
    }

    &.is-active {
        border-color: var(--el-color-primary);
        background-color: var(--el-color-primary-light-9);
    }

    .icons-item-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 70px;
        overflow: hidden;
    }

    .icons-item-name {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.3;
        color: var(--el-text-color-secondary);
        word-break: break-all;

        :deep(.icons-hit) {
            font-style: normal;
            color: var(--el-color-primary);
            font-weight: 600;
        }
    }
}

.icons-empty-tip {
    margin-top: 4px;
    font-size: 12px;
    color: var(--el-text-color-placeholder);
}

.icons-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 15px;

    .icons-count {
        font-size: 12px;
        color: var(--el-text-color-secondary);
    }
}

.icons-colors {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
}

.icons-color {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;

    &:hover {
        border-color: var(--el-color-primary-light-5);
    }

    &.is-active {
        border-color: var(--el-color-primary);
        background-color: var(--el-color-primary-light-9);
    }

    .icons-color-dot {
        flex-shrink: 0;
        width: 24px;
        height: 24px;
        border-radius: 4px;
        border: 1px solid var(--el-border-color);
    }

    .icons-color-meta {
        overflow: hidden;

        .icons-color-name {
            font-size: 13px;
            color: var(--el-text-color-primary);
        }

        .icons-color-value,
        .icons-color-hex {
            font-size: 12px;
            color: var(--el-text-color-secondary);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
    }
}

.icons-samples {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 12px;
}

.icons-sample {
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 6px;
    padding: 10px 12px;

    .icons-sample-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .icons-sample-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--el-text-color-primary);
    }

    .icons-sample-desc {
        margin: 4px 0 8px;
        font-size: 12px;
        color: var(--el-text-color-secondary);
    }
}

.icons-code {
    margin: 0;
    padding: 10px 12px;
    background: var(--el-fill-color-light);
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-primary);
    white-space: pre-wrap;
    word-break: break-all;
}

.icons-notes {
    margin: 0;
    padding-left: 20px;
    font-size: 13px;
    line-height: 2;
    color: var(--el-text-color-regular);
}
</style>
