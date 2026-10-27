<template>
  <el-dialog v-model="visible" title="项目发布(STEP) 功能说明" width="900px" draggable class="help-dialog">
    <div class="help-body">
      <el-alert type="success" :closable="false" show-icon style="margin-bottom: 12px">
        <template #title>第一次使用？看一遍下面内容即可上手。核心流程只有四步：获取程序集 → 打包WPF → 上传程序集 → 发布。</template>
      </el-alert>

      <!-- 内容由同目录 help.md 维护，此处仅负责渲染（GitHub markdown 预览样式） -->
      <div class="markdown-body help-markdown-body" v-html="helpHtml"></div>
    </div>
    <template #footer>
      <el-button @click="visible = false">我已了解，关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts" name="publishStepHelpDialog">
import { ref, computed } from "vue";
import MarkdownIt from "markdown-it";
import "github-markdown-css/github-markdown-light.css";
// 功能说明正文：直接维护同目录下的 help.md（Vite ?raw 以字符串引入，随打包发布）
import helpMarkdown from "../help.md?raw";

const visible = ref(false);

// markdown 渲染（内容为本地内置文档，非用户输入，无需额外消毒）
const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
const helpHtml = computed(() => md.render(helpMarkdown));

const openDialog = () => {
  visible.value = true;
};

defineExpose({ openDialog });
</script>

<style scoped lang="scss">
.help-body {
  max-height: 65vh;
  overflow-y: auto;
  padding-right: 6px;
}

// GitHub 预览样式适配弹窗：缩小基准字号、去掉其自带的外框与内边距，避免引入全局污染
:deep(.help-markdown-body) {
  font-size: 13px;
  padding: 0;
  background: transparent;
  color: var(--el-text-color-primary);

  h1,
  h2 {
    border-bottom-color: var(--el-border-color-lighter);
  }

  h2 {
    font-size: 16px;
  }

  h3 {
    font-size: 14px;
  }

  table {
    font-size: 13px;

    th,
    td {
      text-align: left;
    }

    // github-markdown-light.css 表格底色是写死的白色，这里改用主题变量，深浅色都由主题控制
    tr {
      background-color: transparent;
      border-top: 1px solid var(--el-border-color);
    }

    tr:nth-child(2n) {
      background-color: var(--el-fill-color-lighter);
    }

    th,
    td {
      border: 1px solid var(--el-border-color);
    }

    th {
      background-color: var(--el-fill-color-light);
      color: var(--el-text-color-primary);
    }
  }

  blockquote {
    color: var(--el-text-color-secondary);
    border-left-color: var(--el-border-color);
  }

  code {
    font-size: 12px;
    background-color: var(--el-fill-color);
    color: var(--el-color-primary);
  }
}
</style>
