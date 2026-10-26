<template>
  <el-dialog
    v-model="state.visible"
    :title="state.title"
    width="80%"
    :close-on-click-modal="false"
    draggable
    class="server-log-dialog"
    @closed="onClosed"
  >
    <div class="log-meta">
      <el-tag size="small" type="primary" effect="plain">{{ state.label }}</el-tag>
      <el-tag size="small" type="info" effect="plain">{{ state.serverOsText }}</el-tag>
      <span class="log-path" :title="state.remotePath">{{ state.remotePath }}</span>
    </div>
    <div class="log-body" v-loading="state.loading">
      <pre v-if="state.content" class="log-content">{{ state.content }}</pre>
      <el-empty
        v-else-if="!state.loading && !state.error"
        :description="state.emptyText"
        :image-size="70"
      />
      <el-alert
        v-else-if="!state.loading && state.error"
        :title="state.error"
        type="error"
        :closable="false"
        show-icon
      />
    </div>
    <template #footer>
      <div class="log-footer">
        <span class="log-tip">{{ state.tip }}</span>
        <div>
          <el-button size="default" :loading="state.loading" @click="loadLog">刷新</el-button>
          <el-button size="default" type="primary" @click="state.visible = false">关闭</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts" name="serverLogDialog">
import { reactive } from "vue";
import { cmdInvoke } from "@/utils/command";
import { displayOs } from "@/utils/other";
import {
  buildRemoteLogTailCommand,
  resolveServerLogTarget,
  SERVER_LOG_ERROR,
  SERVER_LOG_MISSING,
  type ServerLogType,
} from "@/utils/serverLog";

// 查看的日志行数（最新 N 行）
const MAX_LINES = 100;

const state = reactive({
  visible: false,
  loading: false,
  title: "",
  label: "",
  serverOsText: "",
  remotePath: "",
  content: "",
  error: "",
  tip: "",
  emptyText: "",
});

// 当前查看的服务器与日志类型（刷新复用）
let currentServer: RowServerType | null = null;
let currentType: ServerLogType = "backup";

// 读取日志（最新 MAX_LINES 行）
const loadLog = async () => {
  const server = currentServer;
  if (!server) return;
  const target = resolveServerLogTarget(server, currentType);
  if (!target.ok) {
    state.error = target.message;
    state.emptyText = "";
    return;
  }

  state.loading = true;
  state.content = "";
  state.error = "";
  state.tip = "";

  const result = await cmdInvoke<string>("execute_remote_command", {
    username: server.account,
    password: server.pwd,
    server: `${server.ip}:${server.port}`,
    command: buildRemoteLogTailCommand(Number(server.os), target.remotePath, MAX_LINES),
    // 查看类命令无需重试：失败重试只会让弹窗多等几轮，日志异常本身也不会因重试而恢复
    retryCount: 1,
  });
  state.loading = false;

  if (result.code !== 0) {
    state.error = String(result.data ?? "读取日志失败");
    state.emptyText = "";
    return;
  }

  const text = String(result.data ?? "").replace(/\r\n/g, "\n").trim();
  if (text.startsWith(SERVER_LOG_MISSING)) {
    state.emptyText = `该服务器暂无${target.option.label}，执行相关操作后自动生成`;
    return;
  }
  if (text.startsWith(SERVER_LOG_ERROR)) {
    state.error = text.replace(SERVER_LOG_ERROR, "").trim() || "读取日志失败";
    state.emptyText = "";
    return;
  }
  if (!text) {
    state.emptyText = `${target.option.label}文件为空`;
    return;
  }

  state.content = text;
  const lineCount = text.split("\n").length;
  state.tip =
    lineCount >= MAX_LINES
      ? `仅显示最新 ${MAX_LINES} 行（文件内容更多）`
      : `共 ${lineCount} 行`;
};

// 打开弹窗（父页面已完成路径校验）
const openDialog = (server: RowServerType, type: ServerLogType) => {
  const target = resolveServerLogTarget(server, type);
  if (!target.ok) return true;
  currentServer = server;
  currentType = type;
  state.visible = true;
  state.label = target.option.label;
  state.title = `${server.name} - ${target.option.label}`;
  state.remotePath = target.remotePath;
  state.serverOsText = displayOs(Number(server.os));
  state.content = "";
  state.error = "";
  state.tip = "";
  state.emptyText = "";
  loadLog();
  return true;
};

const onClosed = () => {
  currentServer = null;
  state.content = "";
  state.error = "";
  state.tip = "";
  state.emptyText = "";
};

defineExpose({ openDialog });
</script>

<style scoped lang="scss">
.log-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
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
  min-height: 200px;
  max-height: 80vh;
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
