<template>
    <el-dialog v-model="visible" :title="dialogTitle" width="90vw" top="5vh" draggable
        :close-on-click-modal="false" :before-close="onBeforeClose" modal-class="server-file-dialog">
        <div class="server-file" v-loading="loadingDir">
            <el-alert v-if="!uploadPaths.length" type="warning" :closable="false" show-icon
                title="该服务器未配置文件管理路径" description="请先在服务器【修改】中补录「文件管理路径」，或使用「识别文件夹」自动识别。"
                class="mb10" />

            <el-form v-else label-width="6.5rem" size="default" class="server-file-form">
                <el-form-item label="管理路径">
                    <div class="path-row">
                        <div class="path-list">
                            <el-checkbox v-for="path in uploadPaths" :key="path"
                                :model-value="selectedPaths.includes(path)" :disabled="busy"
                                @change="(checked: any) => togglePath(path, !!checked)">
                                {{ path }}
                            </el-checkbox>
                        </div>
                        <div class="path-actions">
                            <!-- 始终显示：未唯一勾选时置灰（title 说明原因） -->
                            <el-button title="仅勾选一个管理路径时可查看文件" :disabled="busy || selectedPaths.length !== 1"
                                @click="onViewFiles">
                                查看文件
                            </el-button>
                            <div class="path-bulk">
                                <el-button size="small" :disabled="busy || selectedPaths.length === uploadPaths.length"
                                    @click="setAllPaths(true)">
                                    全选
                                </el-button>
                                <el-button size="small" :disabled="busy || selectedPaths.length === 0"
                                    @click="setAllPaths(false)">
                                    取消全选
                                </el-button>
                            </div>
                        </div>
                    </div>
                </el-form-item>
            </el-form>

            <el-tabs v-model="activeTab" class="server-file-tabs">
                <el-tab-pane label="上传记录" name="upload">
                    <div class="pane-fill">
                        <div class="exist-file-bar">
                            <span class="hint">存在文件</span>
                            <el-radio-group v-model="conflictMode" size="small" :disabled="busy">
                                <el-radio border value="skip">跳过</el-radio>
                                <el-radio border value="overwrite">覆盖</el-radio>
                                <el-radio border value="keepLatest">保留最新</el-radio>
                            </el-radio-group>
                            <span class="hint exist-hint">
                                同路径已有同名文件时：跳过 = 保留服务器文件，覆盖 = 用本地文件替换，保留最新 = 比较两端修改时间后保留较新的那份
                            </span>
                            <div class="exist-file-actions">
                                <el-button size="small" :disabled="uploading || tasks.length === 0"
                                    :title="uploading ? '上传进行中，无法清空' : ''" @click="onClearTasks">
                                    清空
                                </el-button>
                            </div>
                        </div>
                        <el-table :data="tasks" size="small" height="100%" class="fill-table" empty-text="尚未选择文件">
                            <el-table-column type="index" label="#" width="50" />
                            <el-table-column prop="fileName" label="文件" min-width="150" show-overflow-tooltip />
                            <el-table-column prop="remotePath" label="目标路径" min-width="240" show-overflow-tooltip />
                            <el-table-column label="状态" width="100">
                                <template #default="{ row }">
                                    <el-tag size="small" :type="row.tagType">{{ row.status }}</el-tag>
                                </template>
                            </el-table-column>
                            <el-table-column label="进度" width="170">
                                <template #default="{ row }">
                                    <el-progress :percentage="row.percent" :status="row.progressStatus"
                                        :stroke-width="10" />
                                </template>
                            </el-table-column>
                            <el-table-column prop="message" label="结果" min-width="160" show-overflow-tooltip />
                        </el-table>
                    </div>
                </el-tab-pane>
                <el-tab-pane label="浏览文件" name="browse">
                    <div class="pane-fill">
                        <div class="browse-bar">
                            <span class="hint browse-path">
                                <template v-if="loadedPath">
                                    路径：{{ loadedPath }}（共 {{ dirEntries.length }} 项<template v-if="searchTokens.length > 0">，匹配 {{ filteredDirEntries.length }} 项</template>）
                                </template>
                                <template v-else>请勾选 1 个管理路径后点击「查看文件」</template>
                            </span>
                            <span v-if="loadedPath && selectedPaths.length === 1 && selectedPaths[0] !== loadedPath"
                                class="hint browse-diverged">
                                勾选已变更，点「刷新」切换
                            </span>
                            <el-input v-model="searchKeyword" class="browse-search" size="small" clearable
                                :disabled="dirEntries.length === 0" placeholder="搜索名称（仅匹配已读取结果）">
                                <template #prefix>
                                    <el-icon><Search /></el-icon>
                                </template>
                            </el-input>
                            <div class="browse-actions">
                                <el-button size="small"
                                    :disabled="busy || (selectedPaths.length !== 1 && !loadedPath)"
                                    @click="onRefreshDir">刷新</el-button>
                                <el-button size="small" type="primary" plain
                                    :disabled="busy || dirFileSelected.length === 0" @click="onDownloadSelected">
                                    下载所选{{ dirFileSelected.length > 0 ? `（${dirFileSelected.length}）` : "" }}
                                </el-button>
                                <el-button size="small" type="danger" plain :disabled="busy || dirSelected.length === 0"
                                    @click="onDeleteSelected">
                                    删除所选{{ dirSelected.length > 0 ? `（${dirSelected.length}）` : "" }}
                                </el-button>
                            </div>
                        </div>
                        <div v-if="downloading" class="download-progress">
                            <span class="hint">
                                正在下载 {{ downloadState.fileName }}
                                <template v-if="downloadState.total > 1">（{{ downloadState.index }}/{{ downloadState.total }}）</template>
                            </span>
                            <el-progress :percentage="downloadState.percent" :stroke-width="10" />
                        </div>
                        <el-table ref="dirTableRef" :data="filteredDirEntries" size="small" height="100%"
                            class="fill-table" row-key="path"
                            :empty-text="searchTokens.length > 0 ? '没有匹配的条目' : '该路径下没有文件或文件夹'"
                            @selection-change="onDirSelectionChange">
                            <el-table-column type="selection" width="46" reserve-selection />
                            <el-table-column label="名称" min-width="240" show-overflow-tooltip sortable
                                :sort-method="sortByName">
                                <template #default="{ row }">
                                    <span class="entry-name">{{ row.isDir ? "📁" : "📄" }} {{ row.name }}</span>
                                </template>
                            </el-table-column>
                            <el-table-column label="类型" width="90" sortable :sort-method="sortByType">
                                <template #default="{ row }">
                                    <el-tag size="small" :type="row.isDir ? 'success' : 'info'">{{ row.isDir ? "文件夹" : "文件" }}</el-tag>
                                </template>
                            </el-table-column>
                            <el-table-column label="大小" width="110" sortable :sort-method="sortBySize">
                                <template #default="{ row }">{{ row.isDir ? "—" : formatFileSize(row.size) }}</template>
                            </el-table-column>
                            <el-table-column label="修改时间" width="170" sortable :sort-method="sortByModified">
                                <template #default="{ row }">
                                    {{ row.modified > 0 ? formatDate(new Date(row.modified * 1000), "YYYY-mm-dd HH:MM:SS") : "—" }}
                                </template>
                            </el-table-column>
                            <el-table-column label="操作" width="120" fixed="right">
                                <template #default="{ row }">
                                    <el-button v-if="!row.isDir" size="small" text type="primary" :disabled="busy"
                                        @click="onDownloadRow(row)">
                                        下载
                                    </el-button>
                                    <span v-else class="hint row-action-empty">—</span>
                                    <el-button size="small" text type="danger" :disabled="busy"
                                        @click="onDeleteRow(row)">
                                        删除
                                    </el-button>
                                </template>
                            </el-table-column>
                        </el-table>
                    </div>
                </el-tab-pane>
            </el-tabs>
        </div>
        <template #footer>
            <div class="dialog-footer">
                <span v-if="busy || loadingDir" class="hint footer-hint">{{ busyHint }}</span>
                <el-button v-if="busy || loadingDir" type="danger" plain :loading="terminating" @click="onTerminate">
                    终止操作
                </el-button>
                <el-button type="primary" :disabled="!canUpload" :loading="uploading" @click="onChooseFiles">
                    选择文件上传
                </el-button>
                <el-button @click="onClose" size="default" :disabled="busy">关闭</el-button>
            </div>
        </template>
    </el-dialog>
</template>

<script setup lang="ts" name="serverFileDialog">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { cmdInvoke } from "@/utils/command";
import {
    buildRemoteDeleteCommand,
    formatFileSize,
    joinRemotePath,
    REMOTE_OP_OK,
} from "@/utils/remoteFs";
import { formatDate } from "@/utils/formatTime";
import { Local } from "@/utils/storage";
import { Search } from "@element-plus/icons-vue";

/** 上传进度事件负载（与后端 utils/progress.rs 一致） */
type FileProgressPayload = {
    kind?: string;
    file?: string;
    current?: number;
    total?: number;
    percent?: number;
    fileIndex?: number;
    fileTotal?: number;
};

/** 上传结果（与后端 UploadOutcome 一致） */
type UploadOutcome = {
    total: number;
    uploaded: number;
    skipped: number;
    skippedFiles: string[];
};

/** 远端目录条目（与后端 RemoteDirEntry 一致） */
type RemoteDirEntry = {
    name: string;
    path: string;
    isDir: boolean;
    size: number;
    modified: number;
};

type UploadTaskStatus = "等待中" | "上传中" | "完成" | "已跳过" | "失败" | "已终止";

/** 「存在文件」处理方式 */
type ConflictMode = "skip" | "overwrite" | "keepLatest";
const CONFLICT_MODES: ConflictMode[] = ["skip", "overwrite", "keepLatest"];
/** 默认处理方式：首次使用/缓存失效时按「保留最新」 */
const DEFAULT_CONFLICT_MODE: ConflictMode = "keepLatest";
/** localStorage 键（经 Local 包装后实际为 `<__NEXT_NAME__>:serverFileConflictMode`） */
const CONFLICT_MODE_KEY = "serverFileConflictMode";

/** 读取上次选择的处理方式，值非法/缺失时回退默认（保留最新） */
const readConflictMode = (): ConflictMode => {
    const saved = Local.get(CONFLICT_MODE_KEY);
    return CONFLICT_MODES.includes(saved) ? (saved as ConflictMode) : DEFAULT_CONFLICT_MODE;
};

type UploadTask = {
    fileName: string;
    localPath: string;
    remotePath: string;
    status: UploadTaskStatus;
    tagType: "primary" | "success" | "warning" | "info" | "danger";
    progressStatus: "" | "success" | "warning" | "exception";
    percent: number;
    message: string;
};

const visible = ref(false);
const server = ref<RowServerType | null>(null);
const uploadPaths = ref<string[]>([]);
const selectedPaths = ref<string[]>([]);
const conflictMode = ref<ConflictMode>(readConflictMode());
const activeTab = ref<"upload" | "browse">("upload");

const tasks = ref<UploadTask[]>([]);
const uploading = ref(false);
const deleting = ref(false);
const terminating = ref(false);
/** 当前正在上传的任务下标（进度事件只写这一行） */
const activeTaskIndex = ref(-1);

const loadingDir = ref(false);
const dirEntries = ref<RemoteDirEntry[]>([]);
const dirSelected = ref<RemoteDirEntry[]>([]);
const dirTableRef = ref();
/** 当前列表实际读取的路径（不随勾选变化，避免「显示的路径」与「列表内容」错位） */
const loadedPath = ref("");
/** 浏览页搜索关键词：只过滤已读取到的结果，按键不请求服务器 */
const searchKeyword = ref("");

/** 关键词按空白拆分，多个词需同时命中（忽略大小写） */
const searchTokens = computed(() =>
    searchKeyword.value
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
);
const filteredDirEntries = computed(() => {
    const tokens = searchTokens.value;
    if (tokens.length === 0) return dirEntries.value;
    return dirEntries.value.filter((row) => {
        const name = row.name.toLowerCase();
        return tokens.every((token) => name.includes(token));
    });
});

/** 下载状态（多文件时按下标显示进度） */
const downloading = ref(false);
const downloadState = reactive({ index: 0, total: 0, fileName: "", percent: 0 });

let unlistenProgress: (() => void) | null = null;

const busy = computed(() => uploading.value || deleting.value || downloading.value);
const canUpload = computed(() => !busy.value && selectedPaths.value.length > 0);
/** 选中项中的文件（不含文件夹，下载只支持文件） */
const dirFileSelected = computed(() => dirSelected.value.filter((row) => !row.isDir));

// ============ 列头本地排序（不请求服务器） ============

/** 名称比较：中文按拼音、数字按大小（「模板2」排在「模板10」前） */
const compareName = (a: RemoteDirEntry, b: RemoteDirEntry) =>
    a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });

const sortByName = (a: RemoteDirEntry, b: RemoteDirEntry) => compareName(a, b);

/** 类型：升序「文件夹 → 文件」，同类型再按名称 */
const sortByType = (a: RemoteDirEntry, b: RemoteDirEntry) =>
    Number(b.isDir) - Number(a.isDir) || compareName(a, b);

/** 大小：目录按 0 处理，同大小再按名称 */
const sortBySize = (a: RemoteDirEntry, b: RemoteDirEntry) =>
    (a.isDir ? 0 : Number(a.size)) - (b.isDir ? 0 : Number(b.size)) || compareName(a, b);

/** 修改时间：未知（0）参与排序的最小值，同时间再按名称 */
const sortByModified = (a: RemoteDirEntry, b: RemoteDirEntry) =>
    Number(a.modified) - Number(b.modified) || compareName(a, b);
/** 底部状态提示（上传/下载/删除/读取目录） */
const busyHint = computed(() => {
    if (uploading.value) return "上传进行中，可点击「终止操作」提前结束…";
    if (downloading.value) return "下载进行中，可点击「终止操作」提前结束…";
    if (deleting.value) return "删除进行中，可点击「终止操作」提前结束…";
    if (loadingDir.value) return "正在读取远程目录，可点击「终止操作」停止…";
    return "";
});
const dialogTitle = computed(() =>
    server.value ? `文件管理 - ${server.value.name}（${server.value.ip}:${server.value.port}）` : "文件管理"
);

/** 服务器连接参数（复用服务器行上的账号/密码/地址） */
const serverArgs = () => ({
    username: String(server.value?.account ?? ""),
    password: String(server.value?.pwd ?? ""),
    server: `${server.value?.ip ?? ""}:${server.value?.port ?? 22}`,
});

/** 置位/复位文件操作取消标记（与发布停止标记互不干扰） */
const setFileCancel = async (cancel: boolean) => {
    await cmdInvoke("set_file_op_cancel", { cancel });
};

// 处理方式改动即记忆（全局偏好，下次打开弹窗沿用）；与具体服务器无关
watch(conflictMode, (mode) => Local.set(CONFLICT_MODE_KEY, mode));

// 打开弹窗
const openDialog = (row: RowServerType) => {
    server.value = row;
    uploadPaths.value = Array.isArray(row.uploadPaths) ? row.uploadPaths.filter((path) => !!path) : [];
    // 默认全选（单路径场景免勾选）；查看文件时再让用户收敛到一个
    selectedPaths.value = [...uploadPaths.value];
    conflictMode.value = readConflictMode();
    tasks.value = [];
    activeTaskIndex.value = -1;
    dirEntries.value = [];
    dirSelected.value = [];
    loadedPath.value = "";
    searchKeyword.value = "";
    resetDownloadState();
    activeTab.value = "upload";
    visible.value = true;
};

const onClose = () => {
    visible.value = false;
};

// 关闭前拦截：上传/下载/删除进行中不允许关闭；读取目录中允许关闭（自动终止读取）
const onBeforeClose = (done: () => void) => {
    if (busy.value) {
        ElMessage.warning("正在处理文件，请先等待完成或点击「终止操作」");
        return;
    }
    if (loadingDir.value) {
        // 触发终止标记，让后端读取尽快返回（结果丢弃）
        setFileCancel(true);
    }
    done();
};

const togglePath = (path: string, checked: boolean) => {
    // 切换路径后旧关键词会误导，直接清空（重新查看文件时再从零搜索）
    searchKeyword.value = "";
    if (checked) {
        if (!selectedPaths.value.includes(path)) selectedPaths.value.push(path);
    } else {
        selectedPaths.value = selectedPaths.value.filter((item) => item !== path);
    }
};

/** 全选 / 取消全选管理路径（与单个勾选一致：清空搜索关键词，勾选变更由 loadedPath 提示） */
const setAllPaths = (checked: boolean) => {
    searchKeyword.value = "";
    selectedPaths.value = checked ? [...uploadPaths.value] : [];
};

// ============ 上传 ============

const setTask = (task: UploadTask, status: UploadTaskStatus) => {
    task.status = status;
};

/**
 * 清空上传记录：只清列表（不影响已上传的服务器文件、不动存在文件处理方式）。
 * 上传进行中禁止——任务行正按下标被逐条改写，清空会让循环取到 undefined。
 */
const onClearTasks = () => {
    if (uploading.value || tasks.value.length === 0) return;
    tasks.value = [];
    activeTaskIndex.value = -1;
};

const onProgress = (payload: FileProgressPayload) => {
    if (payload?.kind !== "upload") return;
    const task = tasks.value[activeTaskIndex.value];
    if (!task) return;
    // 事件只带文件名，同名不匹配时忽略（避免与并行的发布上传互相干扰）
    if (payload.file && payload.file !== task.fileName) return;
    const percent = Number(payload.percent ?? 0);
    task.percent = Math.max(0, Math.min(100, Math.round(percent)));
    if (task.percent > 0 && task.status === "等待中") setTask(task, "上传中");
};

// 选择本地文件 → 生成「文件 × 路径」任务 → 确认后顺序上传
const onChooseFiles = async () => {
    if (!canUpload.value) return;
    let chosen: string | string[] | null = null;
    try {
        chosen = await open({ multiple: true, directory: false, title: "选择要上传的文件" });
    } catch (error: any) {
        ElMessage.error("打开文件选择框失败：" + (error?.message ?? String(error)));
        return;
    }
    if (!chosen) {
        ElMessage.info("您已取消选择");
        return;
    }
    const localFiles = (Array.isArray(chosen) ? chosen : [chosen]).filter(Boolean);
    if (localFiles.length === 0) return;

    const targets = [...selectedPaths.value];
    const newTasks: UploadTask[] = [];
    for (const localPath of localFiles) {
        const fileName = localPath.split(/[\\/]/).pop() ?? localPath;
        for (const target of targets) {
            newTasks.push({
                fileName,
                localPath,
                remotePath: joinRemotePath(target, fileName),
                status: "等待中",
                tagType: "info",
                progressStatus: "",
                percent: 0,
                message: "",
            });
        }
    }

    try {
        await ElMessageBox.confirm(
            `将 ${localFiles.length} 个文件上传到 ${targets.length} 个路径，共 ${newTasks.length} 个上传任务。<br/>` +
                `目标已存在同名文件时：<b>${
                    conflictMode.value === "skip"
                        ? "跳过（保留服务器文件）"
                        : conflictMode.value === "keepLatest"
                          ? "保留最新（比较修改时间，留下较新的一份）"
                          : "覆盖（用本地文件替换）"
                }</b>。`,
            "确认上传",
            { confirmButtonText: "开始上传", cancelButtonText: "取消", type: "info", dangerouslyUseHTMLString: true }
        );
    } catch {
        return;
    }

    tasks.value = newTasks;
    activeTab.value = "upload";
    await runUpload();
};

const runUpload = async () => {
    if (uploading.value || tasks.value.length === 0) return;
    uploading.value = true;
    terminating.value = false;
    await setFileCancel(false);
    let terminated = false;
    try {
        // 只处理 kind = "upload"，逐个文件调用，当前任务即唯一活动行
        unlistenProgress = await listen<FileProgressPayload>("file-progress", (event) => {
            onProgress(event.payload ?? {});
        });
        for (let index = 0; index < tasks.value.length; index++) {
            activeTaskIndex.value = index;
            const task = tasks.value[index];
            task.status = "上传中";
            task.tagType = "primary";
            task.message = "";

            const result = await cmdInvoke<UploadOutcome>("upload_server_files", {
                remotePaths: [task.remotePath],
                localPaths: [task.localPath],
                ...serverArgs(),
                conflictMode: conflictMode.value,
                // 文件管理使用独立取消标记（后端 cancel_scope = "file"）
                cancelScope: "file",
                // 重试由界面逐条控制，单条只发一次
                retryCount: 1,
                retryIntervalSecs: 1,
            });

            if (result.code === 0) {
                task.percent = 100;
                if (result.data && result.data.skipped > 0) {
                    task.status = "已跳过";
                    task.tagType = "warning";
                    task.progressStatus = "warning";
                    task.message = conflictMode.value === "keepLatest"
                        ? "服务器版本更新，已保留服务器文件"
                        : "目标已存在同名文件，已跳过";
                } else {
                    task.status = "完成";
                    task.tagType = "success";
                    task.progressStatus = "success";
                    task.message = "上传成功";
                }
                continue;
            }

            const errorText = String(result.data ?? result.msg ?? "");
            if (errorText.includes("已手动终止")) {
                task.status = "已终止";
                task.tagType = "info";
                task.message = "已手动终止";
                terminated = true;
                break;
            }
            task.status = "失败";
            task.tagType = "danger";
            task.progressStatus = "exception";
            task.message = errorText;
        }
    } finally {
        activeTaskIndex.value = -1;
        uploading.value = false;
        terminating.value = false;
        unlistenProgress?.();
        unlistenProgress = null;
        await setFileCancel(false);
    }

    if (terminated) {
        // 未执行的任务统一标记为已终止，避免停留在「等待中」
        for (const task of tasks.value) {
            if (task.status === "等待中") {
                task.status = "已终止";
                task.tagType = "info";
                task.message = "已终止，未执行";
            }
        }
    }
    const failedCount = tasks.value.filter((task) => task.status === "失败").length;
    const doneCount = tasks.value.filter((task) => task.status === "完成").length;
    const skippedCount = tasks.value.filter((task) => task.status === "已跳过").length;
    const summary = `完成 ${doneCount}，跳过 ${skippedCount}，失败 ${failedCount}`;
    if (failedCount > 0) ElMessage.warning(`上传结束：${summary}`);
    else if (terminated) ElMessage.info(`上传已终止：${summary}`);
    else ElMessage.success(`上传结束：${summary}`);
};

// ============ 浏览 / 删除 ============

const onViewFiles = async () => {
    if (selectedPaths.value.length !== 1) {
        ElMessage.warning("请只勾选一个管理路径后再查看文件");
        return;
    }
    activeTab.value = "browse";
    await loadDir(selectedPaths.value[0]);
};

/** 刷新：勾选唯一时切到该路径重读，否则按当前列表所属路径重读 */
const onRefreshDir = () => {
    activeTab.value = "browse";
    return loadDir();
};

const onDirSelectionChange = (rows: RemoteDirEntry[]) => {
    dirSelected.value = rows;
};

/** 清空浏览页勾选：selection 列开了 reserve-selection（跨过滤保留），重新读取目录时必须显式清 */
const clearDirSelection = () => {
    dirSelected.value = [];
    dirTableRef.value?.clearSelection();
};

const loadDir = async (targetPath?: string) => {
    // 目标路径：显式传入 > 当前唯一勾选 > 列表所属路径（勾选变成 0/多个时仍可刷新当前列表）
    const remotePath =
        targetPath ??
        (selectedPaths.value.length === 1 ? selectedPaths.value[0] : loadedPath.value);
    if (!remotePath) {
        ElMessage.warning("请只勾选一个管理路径后再查看文件");
        return;
    }
    loadingDir.value = true;
    terminating.value = false;
    try {
        const result = await cmdInvoke<RemoteDirEntry[]>("list_remote_dir", {
            ...serverArgs(),
            remotePath,
            // 走文件操作独立取消标记，可被「终止操作」/关闭弹窗提前终止
            cancelScope: "file",
        });
        if (result.code !== 0) {
            const errorText = String(result.data ?? "读取远程目录失败");
            dirEntries.value = [];
            loadedPath.value = "";
            clearDirSelection();
            if (errorText.includes("已手动终止")) {
                ElMessage.info("已终止读取远程目录");
            } else {
                ElMessage.error(errorText);
            }
            return;
        }
        dirEntries.value = Array.isArray(result.data) ? result.data : [];
        loadedPath.value = remotePath;
        clearDirSelection();
    } finally {
        loadingDir.value = false;
        terminating.value = false;
        await setFileCancel(false);
    }
};

// ============ 下载（只支持文件，不支持文件夹） ============

const onDownloadRow = (row: RemoteDirEntry) => {
    if (row.isDir) {
        ElMessage.warning("暂不支持下载文件夹");
        return;
    }
    runDownload([row]);
};

const onDownloadSelected = () => {
    if (dirFileSelected.value.length === 0) {
        ElMessage.warning("请选择要下载的文件（不支持下载文件夹）");
        return;
    }
    runDownload(dirFileSelected.value);
};

// 单文件用「另存为」，多文件选定本地目录后按原文件名保存
const chooseLocalTargets = async (files: RemoteDirEntry[]): Promise<string[] | null> => {
    if (files.length === 1) {
        let savePath: string | null = null;
        try {
            savePath = await save({ defaultPath: files[0].name, title: "选择保存位置" });
        } catch (error: any) {
            ElMessage.error("打开保存对话框失败：" + (error?.message ?? String(error)));
            return null;
        }
        if (!savePath) {
            ElMessage.info("您已取消下载");
            return null;
        }
        return [savePath];
    }
    let dir: string | string[] | null = null;
    try {
        dir = await open({ directory: true, multiple: false, title: "选择保存目录" });
    } catch (error: any) {
        ElMessage.error("打开目录选择框失败：" + (error?.message ?? String(error)));
        return null;
    }
    const targetDir = Array.isArray(dir) ? dir[0] : dir;
    if (!targetDir) {
        ElMessage.info("您已取消下载");
        return null;
    }
    // 本地路径统一用正斜杠，Windows 的文件 API 同样接受
    return files.map((file) => `${targetDir}/${file.name}`);
};

const resetDownloadState = () => {
    downloadState.index = 0;
    downloadState.total = 0;
    downloadState.fileName = "";
    downloadState.percent = 0;
};

// 下载：逐个文件调用下载命令，进度写入 downloadState，可被「终止操作」打断
const runDownload = async (rows: RemoteDirEntry[]) => {
    // 路径固定取「列表所属路径」：勾选变化后不会把列表里的条目拼到别的目录上
    const base = loadedPath.value;
    const files = rows.filter((row) => !row.isDir);
    if (!base || files.length === 0 || busy.value) return;

    const targets = await chooseLocalTargets(files);
    if (!targets) return;

    downloading.value = true;
    terminating.value = false;
    await setFileCancel(false);
    resetDownloadState();
    downloadState.total = files.length;

    let successCount = 0;
    let stopped = false;
    const failures: string[] = [];
    try {
        // 与上传共用同一个监听句柄：两者通过 busy 互斥，事件按 kind 区分
        unlistenProgress = await listen<FileProgressPayload>("file-progress", (event) => {
            const payload = event.payload ?? {};
            if (payload.kind !== "download") return;
            if (payload.file && payload.file !== downloadState.fileName) return;
            downloadState.percent = Math.max(0, Math.min(100, Math.round(Number(payload.percent ?? 0))));
        });

        for (let index = 0; index < files.length; index++) {
            // 点了「终止操作」后不再发起新的下载（当前文件在分块读循环内即时中断）
            if (terminating.value) {
                stopped = true;
                break;
            }
            const file = files[index];
            downloadState.index = index + 1;
            downloadState.fileName = file.name;
            downloadState.percent = 0;

            const result = await cmdInvoke<boolean>("download_server_files", {
                localPaths: [targets[index]],
                remotePaths: [joinRemotePath(base, file.name)],
                ...serverArgs(),
                // 文件管理使用独立取消标记（后端 cancel_scope = "file"）
                cancelScope: "file",
                // 重试由界面逐条控制，单条只发一次
                retryCount: 1,
                retryIntervalSecs: 1,
            });

            if (result.code === 0) {
                successCount++;
                continue;
            }
            const errorText = String(result.data ?? result.msg ?? "");
            if (errorText.includes("已手动终止")) {
                stopped = true;
                break;
            }
            failures.push(`${file.name}：${errorText}`);
        }
    } finally {
        downloading.value = false;
        terminating.value = false;
        resetDownloadState();
        unlistenProgress?.();
        unlistenProgress = null;
        await setFileCancel(false);
    }

    const summary = `成功下载 ${successCount} 项，失败 ${failures.length} 项` + (stopped ? "（已终止）" : "");
    if (failures.length > 0) {
        ElMessageBox.alert(
            `${summary}<br/>${failures.slice(0, 20).join("<br/>")}` +
                (stopped ? "<br/>已终止，未下载完成的本地文件可能残留部分内容。" : ""),
            "下载结果",
            { confirmButtonText: "知道了", dangerouslyUseHTMLString: true }
        );
    } else if (stopped) {
        ElMessage.info(`下载已终止：${summary}（未完成的文件可能残留部分内容）`);
    } else {
        ElMessage.success(`下载结束：${summary}`);
    }
};

// 删除：逐条执行远端删除命令，条目之间可被「终止操作」打断（勾选批量与行内单条共用）
const runDelete = async (targetRows: RemoteDirEntry[]) => {
    // 删除目标固定为列表所属路径
    const base = loadedPath.value;
    const rows = [...targetRows];
    if (!base || rows.length === 0 || busy.value) return;

    const preview = rows.slice(0, 5).map((row) => row.name).join("、");
    const tip = rows.length === 1
        ? `将删除 <b>${preview}</b>${rows[0].isDir ? "（文件夹会连同其下所有内容一起删除）" : ""}，<b>无法恢复</b>。`
        : `将删除 <b>${rows.length}</b> 项：${preview}${rows.length > 5 ? " 等" : ""}。<br/>文件夹会连同其下所有内容一起删除，<b>无法恢复</b>。`;
    try {
        await ElMessageBox.confirm(tip, "删除确认", {
            confirmButtonText: "确认删除",
            cancelButtonText: "取消",
            type: "warning",
            dangerouslyUseHTMLString: true,
        });
    } catch {
        return;
    }

    deleting.value = true;
    terminating.value = false;
    await setFileCancel(false);

    let successCount = 0;
    let stopped = false;
    const failures: string[] = [];
    try {
        for (const row of rows) {
            // 用户点「终止操作」后不再发起新的删除（已在执行的单条会自然结束）
            if (terminating.value) {
                stopped = true;
                break;
            }
            // 用「所选路径 + 条目名」重建远端路径，避免直接使用 SFTP 返回的路径形态差异
            const target = joinRemotePath(base, row.name);
            const result = await cmdInvoke<string>("execute_remote_command", {
                ...serverArgs(),
                command: buildRemoteDeleteCommand(Number(server.value?.os), target),
                retryCount: 1,
            });
            const output = String(result.data ?? "").trim();
            if (result.code === 0 && output.startsWith(REMOTE_OP_OK)) successCount++;
            else failures.push(`${row.name}：${output || "删除失败"}`);
        }
    } finally {
        deleting.value = false;
        terminating.value = false;
        await setFileCancel(false);
    }

    const summary = `成功删除 ${successCount} 项，失败 ${failures.length} 项` + (stopped ? "（已终止）" : "");
    if (failures.length > 0) {
        ElMessageBox.alert(`${summary}<br/>${failures.slice(0, 20).join("<br/>")}`, "删除结果", {
            confirmButtonText: "知道了",
            dangerouslyUseHTMLString: true,
        });
    } else {
        ElMessage.success(summary);
    }
    // 按刚删除的路径重读，避免此时勾选已变成别的路径导致列表跳走
    await loadDir(base);
};

/** 操作条：删除勾选项 */
const onDeleteSelected = () => runDelete(dirSelected.value);

/** 操作列：删除单条（文件或文件夹） */
const onDeleteRow = (row: RemoteDirEntry) => runDelete([row]);

// 终止：上传/下载/删除/读取目录共用文件操作取消标记
const onTerminate = async () => {
    if ((!busy.value && !loadingDir.value) || terminating.value) return;
    terminating.value = true;
    await setFileCancel(true);
    if (loadingDir.value) ElMessage.info("已发送终止请求，正在停止读取远程目录");
    else if (uploading.value) ElMessage.info("已发送终止请求，当前文件将尽快停止");
    else if (downloading.value) ElMessage.info("已发送终止请求，当前文件将尽快停止下载");
    else ElMessage.info("已发送终止请求，当前条目处理完后停止删除");
};

onUnmounted(() => {
    unlistenProgress?.();
    unlistenProgress = null;
});

defineExpose({ openDialog });
</script>

<style lang="scss" scoped>
.server-file {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 320px;
    /* 项目内 .el-dialog__body 全局去掉了 padding（serverDialog 的全局样式），这里自行补边距 */
    padding: 6px 12px 0;
}

.server-file-form {
    :deep(.el-form-item) {
        margin-bottom: 10px;
    }
}

/* 「存在文件」：上传记录页签内、列头上方，两个选项间距收紧，说明文字与选项拉开距离 */
.exist-file-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    flex: 0 0 auto;
    gap: 12px;
    row-gap: 6px;

    :deep(.el-radio-group) {
        gap: 6px;
    }

    :deep(.el-radio) {
        margin-right: 0;
        /* 缩小内边距，避免按钮比同行的文字提示还显眼 */
        padding: 3px 10px;
    }

    .exist-hint {
        margin-left: 6px;
    }

    /* 右侧操作（清空）：始终贴右，随 flex-wrap 落到当前行末端 */
    .exist-file-actions {
        margin-left: auto;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
    }
}

.path-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;

    /* 右侧操作列：查看文件在上，全选 / 取消全选在其下方 */
    .path-actions {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
    }

    .path-bulk {
        display: flex;
        justify-content: flex-end;
        gap: 8px;

        .el-button + .el-button {
            margin-left: 0; /* 覆盖 el-button 相邻默认 margin，统一用 gap 控制间距 */
        }
    }
}

.path-list {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 120px;
    overflow-y: auto;
    width: 100%;

    :deep(.el-checkbox) {
        height: 24px;
    }

    :deep(.el-checkbox__label) {
        word-break: break-all;
    }
}

/* 页签占满弹窗剩余高度，表格在页签内部滚动 */
.server-file-tabs {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;

    :deep(.el-tabs__content) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    :deep(.el-tab-pane) {
        height: 100%;
    }
}

.pane-fill {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.fill-table {
    flex: 1;
    min-height: 180px;
}

.browse-bar {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 10px;

    /* 路径提示占剩余宽度并省略，把空间让给搜索框与按钮 */
    .browse-path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .browse-search {
        flex: 0 0 220px;
        width: 220px;
    }

    .browse-actions {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
    }

    /* 勾选路径与列表路径不一致时的提醒（列表不会跟着勾选变化） */
    .browse-diverged {
        flex: 0 0 auto;
        color: var(--el-color-warning);
    }
}

.download-progress {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;

    :deep(.el-progress) {
        flex: 1;
    }

    .hint {
        flex: 0 0 auto;
        max-width: 50%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}

.dialog-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
}

.footer-hint {
    margin-right: auto;
}

.entry-name {
    word-break: break-all;
}

/* 文件夹行「下载」位显示占位符，占住与文件行相近的宽度 */
.row-action-empty {
    display: inline-block;
    width: 28px;
    text-align: center;
}

.hint {
    font-size: 12px;
    color: var(--el-text-color-secondary);
}

.mb10 {
    margin-bottom: 10px;
}
</style>

<style lang="scss">
/* 文件管理弹窗高度约束：modal-class 挂在遮罩层上，需用全局样式匹配（不能 scoped） */
.server-file-dialog {
    .el-dialog {
        display: flex;
        flex-direction: column;
        height: 90vh;
        max-height: 90vh;
        /* 固定 90vh + top 5vh：去掉默认 50px 下边距，避免遮罩层出现滚动条 */
        margin-bottom: 0;
    }

    .el-dialog__body {
        flex: 1;
        min-height: 0;
        overflow: hidden;
    }

    .el-dialog__footer {
        flex: 0 0 auto;
    }
}
</style>
