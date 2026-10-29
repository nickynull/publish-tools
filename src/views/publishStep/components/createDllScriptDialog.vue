<template>
    <el-dialog v-model="visible" title="创建生成DLL脚本" width="640px" draggable :close-on-click-modal="false">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
            <template #title>
                按 TFS/Git 模板生成「获取最新代码 + MSBuild 生成 dll」的 bat 脚本，填入变量后保存到本机即可使用。
            </template>
        </el-alert>
        <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
            <el-form-item label="脚本类型" prop="type">
                <el-radio-group v-model="form.type">
                    <el-radio-button value="TFS">TFS</el-radio-button>
                    <el-radio-button value="Git">Git</el-radio-button>
                </el-radio-group>
            </el-form-item>
            <el-form-item label="代码根目录" prop="projectPath">
                <div class="path-input-row">
                    <el-input v-model="form.projectPath" placeholder="如：D:\Codes\SMOM\SMOM.XXX\SMOM.V10.3"
                        clearable />
                    <el-button :icon="FolderOpened" title="选择目录" :disabled="saving"
                        @click="onSelectProjectPath" />
                </div>
            </el-form-item>
            <el-form-item label="解决方案文件" prop="projectSolution">
                <div class="path-input-row">
                    <el-input v-model="form.projectSolution" placeholder="代码根目录下的解决方案文件，如：SMOM.build.sln"
                        clearable />
                    <el-button :icon="Document" title="选择 .sln 文件" :disabled="saving"
                        @click="onSelectSolutionFile" />
                </div>
            </el-form-item>
            <el-form-item label="生成模式" prop="buildConfiguration">
                <el-select v-model="form.buildConfiguration" style="width: 100%">
                    <el-option label="Release（发布模式，优化代码）" value="Release" />
                    <el-option label="Debug（调试模式，含调试符号）" value="Debug" />
                </el-select>
            </el-form-item>
            <el-form-item label="平台" prop="buildPlatform">
                <el-select v-model="form.buildPlatform" style="width: 100%">
                    <el-option label="Any CPU（不指定具体平台）" value="Any CPU" />
                    <el-option label="x86（32 位平台）" value="x86" />
                    <el-option label="x64（64 位平台）" value="x64" />
                </el-select>
            </el-form-item>
        </el-form>
        <template #footer>
            <el-button :disabled="saving" @click="visible = false">取 消</el-button>
            <el-button type="primary" :loading="saving" @click="onGenerateAndSave">生成并保存</el-button>
        </template>
    </el-dialog>
</template>

<script setup lang="ts" name="publishStepCreateDllScriptDialog">
import { ref, reactive, computed, watch } from "vue";
import { ElMessage } from "element-plus";
import type { FormInstance, FormRules } from "element-plus";
import { FolderOpened, Document } from "@element-plus/icons-vue";
import { open, save } from "@tauri-apps/plugin-dialog";
import { cmdInvoke } from "@/utils/command";
import { buildDllScriptContent, buildDllScriptFileName, type DllScriptType } from "./dllScriptTemplates";

// 项目名/环境名由外层页面透传，用于生成默认保存文件名（如：TFS生成SMOM.V10.3-Pro-Release环境dll.bat）
const props = defineProps<{ modelValue: boolean; projectName?: string; environmentName?: string }>();
const emit = defineEmits(["update:modelValue", "saved"]);
const visible = computed({
    get: () => props.modelValue,
    set: (val: boolean) => emit("update:modelValue", val),
});

const formRef = ref<FormInstance>();
const saving = ref(false);
const form = reactive({
    type: "TFS" as DllScriptType,
    projectPath: "",
    projectSolution: "",
    buildConfiguration: "Release",
    buildPlatform: "Any CPU",
});

const rules: FormRules = {
    projectPath: [{ required: true, message: "请填写或选择代码根目录", trigger: "blur" }],
    projectSolution: [{ required: true, message: "请填写或选择解决方案文件", trigger: "blur" }],
};

// 每次打开重置表单（保留脚本类型与默认生成模式/平台）
watch(visible, (val) => {
    if (val) {
        form.projectPath = "";
        form.projectSolution = "";
        form.buildConfiguration = "Release";
        form.buildPlatform = "Any CPU";
        formRef.value?.clearValidate();
    }
});

// 生成脚本内容后，预填保存对话框的默认文件名（按当前界面 项目 + 环境 + 生成模式 命名）
const defaultFileName = computed(() =>
    buildDllScriptFileName({
        type: form.type,
        projectPath: form.projectPath,
        projectSolution: form.projectSolution,
        buildConfiguration: form.buildConfiguration,
        buildPlatform: form.buildPlatform,
        projectName: props.projectName,
        environmentName: props.environmentName,
    })
);

// 选择代码根目录（统一为 Windows 反斜杠并去掉尾部分隔符，脚本里直接 cd /d 使用）
const onSelectProjectPath = async () => {
    try {
        const dir = await open({ directory: true, multiple: false, title: "选择代码根目录" });
        if (dir) form.projectPath = String(dir).replace(/\//g, "\\").replace(/\\+$/, "");
    } catch (error) {
        console.error("打开目录选择框失败:", error);
        ElMessage.error("打开目录选择框失败");
    }
};

// 选择解决方案文件（.sln），回填文件名（脚本中 msbuild 在代码根目录下执行，只保留文件名）
const onSelectSolutionFile = async () => {
    try {
        const file = await open({
            multiple: false,
            filters: [{ name: "解决方案", extensions: ["sln"] }],
        });
        if (!file) return;
        const winPath = String(file).replace(/\//g, "\\");
        const segments = winPath.split("\\");
        const fileName = segments.pop() || "";
        if (fileName) form.projectSolution = fileName;
        // 代码根目录为空时，用所选 .sln 的上级目录自动填充（省一次目录选择）
        if (!form.projectPath && segments.length > 0) {
            form.projectPath = segments.join("\\");
            ElMessage.success(`已按所选解决方案自动填充代码根目录：${form.projectPath}`);
        } else {
            ElMessage.info(`已选择 ${fileName}，脚本在代码根目录下执行，仅使用解决方案文件名`);
        }
    } catch (error) {
        console.error("打开文件选择框失败:", error);
        ElMessage.error("打开文件选择框失败");
    }
};

// 生成并保存：校验 → 渲染脚本 → 系统保存对话框 → 写盘
const onGenerateAndSave = async () => {
    const valid = await formRef.value?.validate().catch(() => false);
    if (!valid) return;

    saving.value = true;
    try {
        const formSnapshot = {
            type: form.type,
            projectPath: form.projectPath,
            projectSolution: form.projectSolution,
            buildConfiguration: form.buildConfiguration,
            buildPlatform: form.buildPlatform,
        };
        const content = buildDllScriptContent(formSnapshot);
        let filePath = "";
        try {
            filePath = (await save({
                defaultPath: defaultFileName.value,
                filters: [{ name: "批处理脚本", extensions: ["bat"] }],
            })) as unknown as string;
        } catch (error) {
            console.error("打开保存对话框失败:", error);
            ElMessage.error("打开保存对话框失败");
            return;
        }
        if (!filePath) {
            ElMessage.info("您已取消保存");
            return;
        }
        // 补 .bat 后缀（保存对话框改名去掉后缀时兜底）
        if (!/\.bat$/i.test(filePath)) filePath += ".bat";

        const saveResult = await cmdInvoke("save_content_to_file", { content, filePath });
        if (saveResult.code !== 0) {
            ElMessage.error(`保存脚本失败：${saveResult.data}`);
            return;
        }
        ElMessage.success(`DLL生成脚本已保存到：${filePath}`);
        visible.value = false;
        // 通知外层：可把该脚本关联为当前「项目 + 环境」的生成DLL脚本
        emit("saved", filePath);
    } finally {
        saving.value = false;
    }
};
</script>

<style scoped lang="scss">
.path-input-row {
    display: flex;
    width: 100%;
    gap: 8px;

    .el-input {
        flex: 1;
    }
}
</style>
