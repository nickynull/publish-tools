<template>
  <div class="about-container">
    <el-card shadow="never" class="about-card">
      <div class="about-body">
        <el-icon class="about-icon"><Platform /></el-icon>
        <div class="about-name">SMOM平台发布工具</div>
        <div class="about-version">v{{ appVersion }}</div>
        <div class="about-meta">
          <div class="about-meta-item">
            <span class="about-meta-label">{{ $t('message.about.author') }}</span>
            <span class="about-meta-value">Jimmy</span>
          </div>
          <div class="about-meta-item">
            <span class="about-meta-label">{{ $t('message.about.repoUrl') }}</span>
            <el-link type="primary" :underline="false" @click="onOpenLink(PROJECT_REPO_URL)">
              {{ PROJECT_REPO_URL }}
            </el-link>
          </div>
          <div class="about-meta-item">
            <span class="about-meta-label">{{ $t('message.about.forkUrl') }}</span>
            <el-link type="primary" :underline="false" @click="onOpenLink(UPSTREAM_REPO_URL)">
              {{ UPSTREAM_REPO_URL }}
            </el-link>
          </div>
          <div class="about-meta-item">
            <span class="about-meta-label">{{ $t('message.about.forkVersion') }}</span>
            <span class="about-meta-value">v{{ MERGED_UPSTREAM_VERSION }}</span>
          </div>
        </div>
        <el-button type="primary" :loading="checkingUpdate" @click="onCheckUpdate">
          {{ $t('message.about.checkUpdate') }}
        </el-button>
      </div>
    </el-card>
    <!-- 升级弹窗（与 App.vue 启动时检查更新共用同一组件与流程） -->
    <upgrade
      v-if="hasUpdate"
      ref="upgradeRef"
      :date="pendingUpdate?.date"
      :version="pendingUpdate?.version"
      :body="upgradeBody"
      @confirm-updater="onConfirmUpdater"
      @download-finished="onDownloadFinished"
    />
  </div>
</template>

<script setup lang="ts" name="about">
import { ref, nextTick, onMounted, defineAsyncComponent } from "vue";
import { ElMessage } from "element-plus";
import { Platform } from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import { check, Update } from "@tauri-apps/plugin-updater";
import { cmdInvoke } from "@/utils/command";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchGithubReleaseNotes } from "@/utils/githubRelease";

// 仓库与 fork 来源信息（生产环境无 git，无法运行时推导，改地址/合并 upstream 后需手动同步）
const PROJECT_REPO_URL = "https://github.com/nickynull/publish-tools";
const UPSTREAM_REPO_URL =
  "https://github.com/SIE-Operations-and-Maintenance-Team/publish-tools";
// 当前已合并的 fork 来源版本：合并 upstream 新 tag 后同步此值
const MERGED_UPSTREAM_VERSION = "1.0.0";

// 升级弹窗组件（复用 App.vue 启动时检查更新同款组件）
const Upgrade = defineAsyncComponent(() => import("@/layout/upgrade/index.vue"));

const { t } = useI18n();
const appVersion = ref("");
const checkingUpdate = ref(false);
const hasUpdate = ref(false);
let pendingUpdate: Update | null = null;
const upgradeBody = ref("");
const upgradeRef = ref();

// 获取当前应用版本号（Tauri 包信息，与 package.json 同步）
onMounted(() => {
  getVersion().then((v) => (appVersion.value = v)).catch(() => {});
});

// 打开外链（系统默认浏览器）
const onOpenLink = (url: string) => {
  openUrl(url).catch((e) => {
    ElMessage.error(t('message.about.openLinkFailed') + ': ' + e);
  });
};

// 检查更新：有更新时弹出升级弹窗（与 App.vue 启动时同一流程），无更新则提示
const onCheckUpdate = async () => {
  checkingUpdate.value = true;
  try {
    const update = await check();
    if (!update) {
      ElMessage.success(t('message.about.alreadyLatest'));
      return;
    }
    pendingUpdate = update;
    // 弹窗内容先用 update.json notes 兜底，拉到 GitHub Release 说明后替换
    upgradeBody.value = update.body ?? "";
    hasUpdate.value = true;
    const version = update.version;
    fetchGithubReleaseNotes(version).then((notes) => {
      // 仅当仍是同一次更新时再替换，防止竞态覆盖
      if (notes && pendingUpdate?.version === version) upgradeBody.value = notes;
    });
    // 组件挂载后立即显示弹窗（跳过组件内启动场景的延迟）
    await nextTick();
    upgradeRef.value?.open();
  } catch (e) {
    ElMessage.error(t('message.about.checkUpdateFailed') + ': ' + e);
  } finally {
    checkingUpdate.value = false;
  }
};

// 确认更新（下载并安装，进度回调给弹窗）
const onConfirmUpdater = async (isUpdater: boolean) => {
  if (!isUpdater || !pendingUpdate) return;
  await pendingUpdate.downloadAndInstall((event) => {
    upgradeRef.value?.downloadEvent(event);
  });
};

// 下载完成：提示后重启应用
const onDownloadFinished = () => {
  ElMessage.success({
    duration: 5 * 1000,
    message: "更新成功，正在重启！",
    onClose: async () => {
      await cmdInvoke("restart_app");
    },
  });
};
</script>

<style scoped lang="scss">
.about-container {
  padding: 15px;
  .about-card {
    .about-body {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 0;
      .about-icon {
        font-size: 56px;
        color: var(--el-color-primary);
        margin-bottom: 15px;
      }
      .about-name {
        font-size: 20px;
        font-weight: bold;
        color: var(--el-text-color-primary);
        margin-bottom: 10px;
      }
      .about-version {
        font-size: 14px;
        color: var(--el-text-color-secondary);
        margin-bottom: 15px;
      }
      .about-meta {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        margin-bottom: 25px;
        font-size: 13px;
        color: var(--el-text-color-regular);
        .about-meta-item {
          display: flex;
          align-items: center;
          gap: 8px;
          .about-meta-label {
            color: var(--el-text-color-secondary);
          }
          .about-meta-value {
            color: var(--el-text-color-primary);
            font-weight: 500;
          }
          :deep(.el-link) {
            font-size: 13px;
          }
        }
      }
    }
  }
}
</style>
