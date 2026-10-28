<template>
  <el-dialog
    v-model="state.visible"
    :title="state.title"
    width="80%"
    top="6vh"
    :close-on-click-modal="false"
    draggable
    class="server-log-dialog"
    @closed="onClosed"
  >
    <el-tabs v-model="activeType" type="border-card" class="log-tabs" @tab-change="onTabChange">
      <el-tab-pane
        v-for="item in tabItems"
        :key="item.opt.type"
        :name="item.opt.type"
        :label="item.opt.label"
        lazy
      >
        <div class="log-meta">
          <el-tag size="small" type="info" effect="plain">{{ state.serverOsText }}</el-tag>
          <span class="log-path" :title="item.tab.remotePath">
            {{ item.tab.remotePath || `${item.opt.pathFieldLabel}未配置` }}
          </span>
        </div>
        <div class="log-body" v-loading="item.tab.loading">
          <pre v-if="item.tab.content" class="log-content">{{ item.tab.content }}</pre>
          <el-empty
            v-else-if="!item.tab.loading && !item.tab.error"
            :description="item.tab.emptyText || '暂无内容'"
            :image-size="70"
          />
          <el-alert
            v-else-if="!item.tab.loading && item.tab.error"
            :title="item.tab.error"
            type="error"
            :closable="false"
            show-icon
          />
        </div>
      </el-tab-pane>
    </el-tabs>
    <template #footer>
      <div class="log-footer">
        <span class="log-tip">{{ currentTab.tip }}</span>
        <div>
          <el-button
            size="default"
            title="下载当前页签对应的完整日志文件"
            :loading="currentTab.downloading"
            :disabled="!currentTab.remotePath"
            @click="onDownload"
            >下载</el-button
          >
          <el-button
            size="default"
            :loading="currentTab.loading"
            :disabled="!currentTab.remotePath"
            @click="loadLog(activeType, true)"
            >刷新</el-button
          >
          <el-button size="default" type="primary" @click="state.visible = false">关闭</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts" name="serverLogDialog">
import { computed, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { save } from "@tauri-apps/plugin-dialog";
import { cmdInvoke } from "@/utils/command";
import { displayOs } from "@/utils/other";
import { formatDate } from "@/utils/formatTime";
import {
  buildLogFileName,
  buildRemoteLogExistsCommand,
  buildRemoteLogTailCommand,
  resolveServerLogTarget,
  SERVER_LOG_ERROR,
  SERVER_LOG_MISSING,
  SERVER_LOG_OPTIONS,
  type ServerLogType,
} from "@/utils/serverLog";

// 预览的日志行数（最新 N 行）；下载始终为服务器上的完整文件
const MAX_LINES = 100;

/** 单个页签的加载状态 */
type ServerLogTabState = {
  /** 正在读取远端日志 */
  loading: boolean;
  /** 是否已加载过（未激活不加载；加载过后除刷新外不再重复加载） */
  loaded: boolean;
  /** 正在下载当前页签日志 */
  downloading: boolean;
  content: string;
  error: string;
  emptyText: string;
  tip: string;
  /** 远端完整路径；路径字段未配置时为空 */
  remotePath: string;
};

const createTabState = (): ServerLogTabState => ({
  loading: false,
  loaded: false,
  downloading: false,
  content: "",
  error: "",
  emptyText: "",
  tip: "",
  remotePath: "",
});

// 四类日志各自持有一份状态，互不影响
const tabStates = reactive({} as Record<ServerLogType, ServerLogTabState>);
SERVER_LOG_OPTIONS.forEach((opt) => {
  tabStates[opt.type] = createTabState();
});

const state = reactive({
  visible: false,
  title: "",
  serverOsText: "",
});

// 当前激活页签（顺序取 SERVER_LOG_OPTIONS：发布 → 备份 → 恢复 → 上传）
const activeType = ref<ServerLogType>(SERVER_LOG_OPTIONS[0].type);
const currentTab = computed(() => tabStates[activeType.value]);
const tabItems = computed(() => SERVER_LOG_OPTIONS.map((opt) => ({ opt, tab: tabStates[opt.type] })));

// 当前查看的服务器（刷新 / 下载复用）
let currentServer: RowServerType | null = null;

/**
 * 读取某个页签的日志（最新 MAX_LINES 行）
 * @param type 日志类型
 * @param force 是否强制刷新：false 时已加载过的页签直接跳过
 */
const loadLog = async (type: ServerLogType, force = false) => {
  const server = currentServer;
  if (!server) return;
  const tab = tabStates[type];
  // 路径未配置：错误提示已在打开弹窗时写入，无需访问远端
  if (!tab.remotePath) return;
  // 已加载过（除刷新外不再重复读取）；正在读取时也不重复发命令
  if (tab.loading || (tab.loaded && !force)) return;

  tab.loading = true;
  tab.content = "";
  tab.error = "";
  tab.emptyText = "";
  tab.tip = "";

  const label = SERVER_LOG_OPTIONS.find((opt) => opt.type === type)?.label ?? "日志";
  const result = await cmdInvoke<string>("execute_remote_command", {
    username: server.account,
    password: server.pwd,
    server: `${server.ip}:${server.port}`,
    command: buildRemoteLogTailCommand(Number(server.os), tab.remotePath, MAX_LINES),
    // 查看类命令无需重试：失败重试只会让弹窗多等几轮，日志异常本身也不会因重试而恢复
    retryCount: 1,
  });
  tab.loading = false;
  tab.loaded = true;

  if (result.code !== 0) {
    tab.error = String(result.data ?? "读取日志失败");
    return;
  }

  const text = String(result.data ?? "").replace(/\r\n/g, "\n").trim();
  if (text.startsWith(SERVER_LOG_MISSING)) {
    tab.emptyText = `该服务器暂无${label}，执行相关操作后自动生成`;
    return;
  }
  if (text.startsWith(SERVER_LOG_ERROR)) {
    tab.error = text.replace(SERVER_LOG_ERROR, "").trim() || "读取日志失败";
    return;
  }
  if (!text) {
    tab.emptyText = `${label}文件为空`;
    return;
  }

  tab.content = text;
  const lineCount = text.split("\n").length;
  tab.tip =
    lineCount >= MAX_LINES ? `仅显示最新 ${MAX_LINES} 行（文件内容更多）` : `共 ${lineCount} 行`;
};

// 切换页签：未加载过的才读取
const onTabChange = (name: any) => {
  loadLog(name as ServerLogType);
};

// 下载当前页签对应的完整日志文件
const onDownload = async () => {
  const server = currentServer;
  if (!server) return;
  const type = activeType.value;
  const tab = tabStates[type];
  if (!tab.remotePath) return;
  const option = SERVER_LOG_OPTIONS.find((opt) => opt.type === type);

  tab.downloading = true;
  try {
    // 先探测远端日志是否存在，避免直接走 SFTP 得到难以理解的报错
    const existsResult = await cmdInvoke<string>("execute_remote_command", {
      username: server.account,
      password: server.pwd,
      server: `${server.ip}:${server.port}`,
      command: buildRemoteLogExistsCommand(Number(server.os), tab.remotePath),
      // 探测类命令无需重试，避免 3 次等待与重试日志
      retryCount: 1,
    });
    if (existsResult.code !== 0) {
      ElMessageBox.alert(String(existsResult.data ?? "探测日志文件失败"), "异常", {
        confirmButtonText: "知道了",
      });
      return;
    }
    if (String(existsResult.data ?? "").trim() !== "1") {
      ElMessage.warning(`该服务器暂无${option?.label ?? "日志"}：${tab.remotePath}`);
      return;
    }

    // 选择保存路径
    let localPath: string | null = null;
    try {
      localPath = await save({
        defaultPath: buildLogFileName(server.name, type, formatDate(new Date(), "YYYYmmddHHMMSS")),
        filters: [{ name: "日志文件", extensions: ["log"] }],
      });
    } catch (error) {
      console.error("打开保存对话框失败:", error);
      ElMessage.error("打开保存对话框失败");
      return;
    }
    if (!localPath) {
      ElMessage.info("您已取消保存");
      return;
    }

    const downloadResult = await cmdInvoke("download_server_files", {
      username: server.account,
      password: server.pwd,
      server: `${server.ip}:${server.port}`,
      remotePaths: [tab.remotePath],
      localPaths: [localPath],
    });
    if (downloadResult.code !== 0) {
      ElMessage.error(`${option?.label ?? "日志"}下载失败：${downloadResult.data}`);
      return;
    }
    ElMessage.success(`日志已保存到：${localPath}`);
  } finally {
    tab.downloading = false;
  }
};

// 打开弹窗：重置全部页签状态，只加载当前激活页签
const openDialog = (server: RowServerType) => {
  currentServer = server;
  state.title = `${server.name} - 操作日志`;
  state.serverOsText = displayOs(Number(server.os));

  // 重置页签状态（关闭前加载过的内容不再保留，下次打开重新读取）
  SERVER_LOG_OPTIONS.forEach((opt) => {
    const target = resolveServerLogTarget(server, opt.type);
    tabStates[opt.type] = {
      ...createTabState(),
      // 路径未配置的页签直接给出提示，不影响其它页签
      remotePath: target.ok ? target.remotePath : "",
      error: target.ok ? "" : target.message,
      loaded: target.ok ? false : true,
    };
  });

  activeType.value = SERVER_LOG_OPTIONS[0].type;
  state.visible = true;
  loadLog(activeType.value);
};

const onClosed = () => {
  currentServer = null;
  SERVER_LOG_OPTIONS.forEach((opt) => {
    tabStates[opt.type] = createTabState();
  });
};

defineExpose({ openDialog });
</script>

<style scoped lang="scss">
.log-tabs {
  /* 内容高度固定，超长日志在正文区内部滚动 */
  :deep(.el-tabs__content) {
    padding: 0;
  }
}
.log-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 6px 6px;
  font-size: 12px;
  .log-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--el-text-color-secondary);
  }
}
.log-body {
  height: 56vh;
  min-height: 200px;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  background: var(--el-fill-color-lighter);
  .log-content {
    margin: 0;
    font-family: Consolas, Monaco, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.7;
    /* 超长行自动换行，不出横向滚动条 */
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--el-text-color-primary);
  }
}
.log-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  .log-tip {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}
</style>
