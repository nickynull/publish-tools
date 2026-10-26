<template>
  <el-dialog v-model="visible" :title="`恢复服务备份 - ${serverName}`" width="640px" draggable>
    <el-form label-width="100px">
      <el-form-item label="备份文件夹">
        <el-select v-model="selectedFolderPath" placeholder="请选择备份文件夹（日期备份下的服务文件夹）" filterable style="width: 100%">
          <el-option v-for="folder in folders" :key="folder.path" :value="folder.path"
            :label="`${folder.dateFolder}/${folder.name}（${folder.time}）`" />
        </el-select>
      </el-form-item>
      <el-form-item label="恢复服务">
        <el-select v-model="selectedServiceIndex" placeholder="请选择恢复服务" filterable style="width: 100%">
          <el-option v-for="(svc, idx) in services" :key="`${svc.module}_${svc.path}_${idx}`" :value="idx"
            :label="`${svc.module} / ${svc.identity || '无服务标识'} / ${svc.path}`" />
        </el-select>
      </el-form-item>
      <el-form-item label="自动匹配">
        <el-switch v-model="autoMatch" />
        <span class="restore-tip">开启后，切换备份文件夹或恢复服务时自动匹配同名（目录名一致）的另一方；关闭后可人工自由选择</span>
      </el-form-item>
      <el-form-item v-if="selectedFolderPath && selectedServiceIndex >= 0" label="恢复内容">
        <el-alert type="info" :closable="false" show-icon>
          <template #title>
            {{ restoreContentText }}，流程：停止服务（如有）→ 替换文件 → 启动服务（如有）
          </template>
        </el-alert>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button v-if="loading" type="danger" plain :icon="VideoPause" title="停止当前恢复操作"
        @click="emit('stop')">停止</el-button>
      <el-button @click="visible = false">取 消</el-button>
      <el-button type="primary" :loading="loading" @click="onConfirm">确定恢复</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts" name="publishStepRestoreBackupDialog">
import { ref, computed, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { VideoPause } from "@element-plus/icons-vue";

export type BackupFolderOption = {
  name: string; // 服务文件夹名（如 webapihost）
  dateFolder: string; // 所属日期备份文件夹名（如 202610242301）
  path: string; // 完整路径（backupBase/日期/服务文件夹）
  time: string; // 日期文件夹修改时间（备份时间）
};
export type RestoreServiceOption = { module: string; path: string; identity: string };
export type RestoreBackupPayload = {
  backupFolderName: string;
  module: string;
  servicePath: string;
  identity: string;
};

const props = defineProps<{
  modelValue: boolean;
  serverName: string;
  folders: BackupFolderOption[];
  services: RestoreServiceOption[];
  loading: boolean;
}>();
const emit = defineEmits(["update:modelValue", "restore", "stop"]);

const visible = computed({
  get: () => props.modelValue,
  set: (val: boolean) => emit("update:modelValue", val),
});

const selectedFolderPath = ref("");
const selectedServiceIndex = ref(-1);
const autoMatch = ref(true);

// 当前选中的服务文件夹名（用于自动匹配）
const selectedFolderName = computed(() => {
  return props.folders.find((f) => f.path === selectedFolderPath.value)?.name || "";
});
// 恢复内容说明：WpfClient 替换全部文件，其余仅替换一级目录中的 DLL
const restoreContentText = computed(() => {
  const svc = props.services[selectedServiceIndex.value];
  const isWpfClient = (svc?.module || "").toLowerCase() === "wpfclient";
  const scopeText = isWpfClient ? "全部文件" : "一级目录中的所有 DLL";
  return `将「${selectedFolderName.value}」的${scopeText}替换到「${svc?.path || ""}」`;
});

// 目录名（服务路径最后一级），用于自动匹配
const leafOf = (path: string) => {
  const segments = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] || "";
};
const folderMatchesService = (folderName: string, leaf: string) => {
  return folderName === leaf || folderName.endsWith(`_${leaf}`);
};

// 打开弹窗时重置选择（只有一个服务时默认选中）
watch(
  () => props.modelValue,
  (val) => {
    if (val) {
      selectedFolderPath.value = "";
      selectedServiceIndex.value = props.services.length === 1 ? 0 : -1;
      autoMatch.value = true;
    }
  }
);

// 自动匹配：服务文件夹 <-> 恢复服务（目录名一致），双方变化时联动
watch(selectedFolderName, (folderName) => {
  if (!autoMatch.value || !folderName) return;
  if (selectedServiceIndex.value >= 0) {
    const leaf = leafOf(props.services[selectedServiceIndex.value]?.path || "");
    if (leaf && folderMatchesService(folderName, leaf)) return; // 当前服务已匹配，不切换
  }
  const idx = props.services.findIndex((svc) => folderMatchesService(folderName, leafOf(svc.path)));
  if (idx >= 0) selectedServiceIndex.value = idx;
});
watch(selectedServiceIndex, (idx) => {
  if (!autoMatch.value || idx < 0) return;
  const leaf = leafOf(props.services[idx]?.path || "");
  if (!leaf) return;
  if (selectedFolderName.value && folderMatchesService(selectedFolderName.value, leaf)) return; // 当前文件夹已匹配，不切换
  const folder = props.folders.find((f) => folderMatchesService(f.name, leaf));
  if (folder) selectedFolderPath.value = folder.path;
});

const onConfirm = async () => {
  if (!selectedFolderPath.value) {
    ElMessage.warning("请选择备份文件夹.");
    return;
  }
  if (selectedServiceIndex.value < 0) {
    ElMessage.warning("请选择恢复服务.");
    return;
  }
  const svc = props.services[selectedServiceIndex.value];
  const folder = props.folders.find((f) => f.path === selectedFolderPath.value);
  const isWpfClient = (svc?.module || "").toLowerCase() === "wpfclient";
  const scopeText = isWpfClient ? "全部文件" : "一级目录中的所有 DLL";
  try {
    await ElMessageBox.confirm(
      `确认恢复？\n备份文件夹：${folder?.dateFolder || ""}/${folder?.name || ""}\n恢复服务：${svc.module} / ${svc.path}\n恢复内容：${scopeText}\n\n流程：停止服务（如有）→ 替换文件 → 启动服务（如有）`,
      "恢复确认",
      { type: "warning", confirmButtonText: "确定恢复", cancelButtonText: "取 消", customStyle: { whiteSpace: "pre-line" } as any }
    );
  } catch {
    return; // 用户取消
  }
  emit("restore", {
    backupPath: selectedFolderPath.value,
    backupLabel: `${folder?.dateFolder || ""}/${folder?.name || ""}`,
    module: svc.module,
    servicePath: svc.path,
    identity: svc.identity || "",
  });
};
</script>

<style scoped lang="scss">
.restore-tip {
  margin-left: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 18px;
}
</style>
