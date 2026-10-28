<template>
    <div class="server-container">
        <el-dialog :title="state.dialog.title" v-model="state.dialog.show" :close-on-click-modal="false"
            modal-class="server-dialog" draggable width="1080px">
            <el-form ref="serverDialogFormRef" :model="state.ruleForm" :rules="formRules" size="default"
                label-width="8rem">
                <el-row :gutter="10">
                    <el-col :span="24" class="mb20">
                        <el-form-item label="服务器名称" prop="name">
                            <el-input v-model="state.ruleForm.name" placeholder="请输入服务器名称" maxlength="50"
                                clearable></el-input>
                        </el-form-item>
                    </el-col>
                    <el-col :span="12" class="mb20">
                        <el-form-item label="IP" prop="ip">
                            <el-input v-model="state.ruleForm.ip" placeholder="请输入IP地址" maxlength="20"
                                clearable></el-input>
                        </el-form-item>
                    </el-col>
                    <el-col :span="12" class="mb20">
                        <el-form-item label="SSH端口" prop="port">
                            <el-input v-model="state.ruleForm.port" placeholder="请输入SSH端口" maxlength="5" clearable
                                @input="
                                    state.ruleForm.port = Number(
                                        verifiyNumberInteger(String(state.ruleForm.port))
                                    )
                                    "></el-input>
                        </el-form-item>
                    </el-col>
                    <el-col :span="12" class="mb20">
                        <el-form-item label="账号" prop="account">
                            <el-input v-model="state.ruleForm.account" placeholder="请输入账号" maxlength="30"
                                clearable></el-input>
                        </el-form-item>
                    </el-col>
                    <el-col :span="12" class="mb20">
                        <el-form-item label="密码" prop="account">
                            <el-input type="password" show-password v-model="state.ruleForm.pwd" placeholder="请输入密码"
                                maxlength="50"></el-input>
                        </el-form-item>
                    </el-col>
                    <el-col :span="12" class="mb20">
                        <el-form-item label="服务环境" prop="os">
                            <el-select v-model="state.ruleForm.os" placeholder="请选择服务环境">
                                <el-option label="Windows" :value="1" />
                                <el-option label="Docker" :value="2" />
                            </el-select>
                        </el-form-item>
                    </el-col>
                    <el-col :span="12" class="mb20">
                        <el-form-item label="所属项目" prop="projectId">
                            <el-select filterable placeholder="请选择所属项目" size="default"
                                v-model="state.ruleForm.projectId">
                                <el-option label="全部（所有项目可用）" :value="0" />
                                <el-option v-for="project in projectList" :key="project.id" :label="project.name"
                                    :value="project.id" />
                            </el-select>
                        </el-form-item>
                    </el-col>
                     <el-col :span="24" class="mb20">
                        <el-form-item label="描述" prop="description">
                            <el-input type="textarea" v-model="state.ruleForm.description" rows="3"
                                placeholder="请输入描述内容…" maxlength="150" show-word-limit clearable></el-input>
                        </el-form-item>
                    </el-col>
                    <el-col :span="24" class="mb20">
                        <el-form-item label="服务备份路径" prop="serviceBackupPath">
                            <el-input v-model="state.ruleForm.serviceBackupPath"
                                placeholder="用于存放备份文件的目录，如 /backup 或 D:\backup（选填）" maxlength="200"
                                clearable></el-input>
                        </el-form-item>
                    </el-col>
                    <el-col :span="24" class="mb20">
                        <el-form-item label="程序集暂存路径" prop="assemblyStagingPath">
                            <el-input v-model="state.ruleForm.assemblyStagingPath"
                                placeholder="用于存放将要发布的程序集的目录，如 /staging 或 D:\staging（选填）" maxlength="200"
                                clearable></el-input>
                        </el-form-item>
                    </el-col>
                    <el-col :span="24" class="mb20">
                        <el-form-item label="服务路径">
                            <div class="default-server-paths">
                                <div class="default-server-path-item"
                                    v-for="(pathItem, pathIndex) in defaultServerPaths" :key="pathIndex">
                                    <el-icon title="移除" color="#F56C6C" :size="20" class="path-remove"
                                        @click="removeDefaultServerPath(pathIndex)">
                                        <Remove />
                                    </el-icon>
                                    <el-select v-model="pathItem.serviceType" placeholder="请选择服务类型（不选则带出到所有服务）"
                                        clearable filterable class="path-type-select">
                                        <el-option v-for="type in serviceTypeOptions" :key="type" :label="type"
                                            :value="type" />
                                    </el-select>
                                    <el-input v-model="pathItem.identity" placeholder="请输入服务标识（选填）" maxlength="200"
                                        clearable>
                                        <template #prepend>服务标识</template>
                                    </el-input>
                                    <el-input v-model="pathItem.path" placeholder="请输入发布路径（选填）" maxlength="200"
                                        clearable>
                                        <template #prepend>发布路径</template>
                                    </el-input>
                                </div>
                                <div class="default-server-paths-actions">
                                    <el-icon v-if="defaultServerPaths.length < 10" title="新增" color="#A8ABB2" :size="26"
                                        @click="addDefaultServerPath">
                                        <CirclePlus />
                                    </el-icon>
                                    <el-button type="primary" plain size="small" :loading="discovering"
                                        @click="onDiscoverServices">
                                        识别服务
                                    </el-button>
                                </div>
                            </div>
                        </el-form-item>
                    </el-col>
                </el-row>
            </el-form>
            <template #footer>
                <span class="dialog-footer">
                    <el-button @click="onCancel" size="default">取消</el-button>
                    <el-button type="primary" @click="submitValidate(serverDialogFormRef)" size="default">{{
                        state.dialog.submitTxt }}</el-button>
                </span>
            </template>
        </el-dialog>
    </div>
</template>

<script setup lang="ts" name="serverDialog">
import { computed, nextTick, reactive, ref } from "vue";
import type { FormInstance, FormRules } from "element-plus";
import { ElMessage } from "element-plus";
import _ from "lodash";
import { useServerDb } from "@/database/servers/index";
import { useProjectDb } from "@/database/project/index";
import { useServiceDiscovery } from "@/composables/useServiceDiscovery";
import { getDefaultSubObject } from "@/utils/other";
import { verifiyNumberInteger } from "@/utils/toolsValidate";
import { CirclePlus, Remove } from "@element-plus/icons-vue";

// 定义子组件向父组件传值/事件
const emit = defineEmits(["refresh"]);

// 引入服务器管理数据库
const serverDb = useServerDb();
const projectDb = useProjectDb();

// 定义变量内容
const serverDialogFormRef = ref();
const projectList = ref<RowProjectType[]>();

const state = reactive<FormDialogType<RowServerType>>({
    ruleForm: {
        id: null,
        projectId: null,
        projectName: null,
        name: "",
        os: 1,
        ip: "",
        port: 22,
        account: "",
        pwd: "",
        description: null,
        serviceBackupPath: null,
        assemblyStagingPath: null,
        defaultServerPaths: [],
    },
    dialog: {
        show: false,
        type: "add",
        editId: null,
        title: "提示",
        submitTxt: "确定",
    },
});

// 默认服务路径组（保证为数组，供模板渲染与增删操作使用）
const defaultServerPaths = computed<ServerDefaultPathType[]>(() => {
    if (!Array.isArray(state.ruleForm.defaultServerPaths)) {
        state.ruleForm.defaultServerPaths = [];
    }
    return state.ruleForm.defaultServerPaths;
});

// 服务类型选项（与应用配置各服务页签对应）
const serviceTypeOptions = ["WebApiHost", "ScheduleServer", "WebClient", "WpfClient", "SpcMonitor"];

// 服务发现（复用服务发现能力，仅追加不覆盖已有组）
const { loadPrefixes, scanRemote, error: discoveryError } = useServiceDiscovery();
const discovering = ref(false);

// 按服务名/显示名推断服务类型（先专后泛，避免 WpfClient 被 WebClient 命中）
const inferServiceType = (serviceName: string, displayName: string) => {
    const text = `${serviceName} ${displayName}`.toLowerCase();
    if (text.includes("wpfclient")) return "WpfClient";
    if (text.includes("webapihost")) return "WebApiHost";
    if (text.includes("scheduleserver")) return "ScheduleServer";
    if (text.includes("spcmonitor")) return "SpcMonitor";
    if (text.includes("webclient")) return "WebClient";
    return null;
};

// 识别服务：扫描远端服务并追加到服务路径组（原有组不动，重复的跳过）
const onDiscoverServices = async () => {
    if (discovering.value) return;
    if (!state.ruleForm.ip || !state.ruleForm.account || !state.ruleForm.pwd) {
        ElMessage.warning("请先填写 IP、账号、密码，再进行服务识别！");
        return;
    }
    discovering.value = true;
    try {
        await loadPrefixes();
        const items = await scanRemote({
            ip: String(state.ruleForm.ip),
            port: Number(state.ruleForm.port) || 22,
            account: String(state.ruleForm.account),
            pwd: String(state.ruleForm.pwd),
            os: Number(state.ruleForm.os),
        });
        if (discoveryError.value) {
            ElMessage.error(`服务识别失败：${discoveryError.value}`);
            return;
        }
        if (!items || items.length < 1) {
            ElMessage.info("未识别到匹配前缀的服务，可在服务发现设置中调整服务名前缀后重试");
            return;
        }
        // 仅追加：与现有组 identity 重复的跳过，识别结果内部也去重
        const existingKeys = new Set(
            defaultServerPaths.value
                .map((group) => (group.identity ?? "").trim().toLowerCase())
                .filter((key) => key !== "")
        );
        const seenKeys = new Set<string>();
        let appended = 0;
        let skipped = 0;
        for (const item of items) {
            const identity = (item.serviceName ?? "").trim();
            if (!identity) continue;
            const key = identity.toLowerCase();
            if (seenKeys.has(key) || existingKeys.has(key) || defaultServerPaths.value.length >= 10) {
                skipped++;
                continue;
            }
            seenKeys.add(key);
            defaultServerPaths.value.push({
                serviceType: inferServiceType(item.serviceName ?? "", item.displayName ?? ""),
                identity,
                path: item.suggestedPublishPath ?? "",
            });
            appended++;
        }
        ElMessage.success(
            `识别到 ${items.length} 个服务：新增 ${appended} 组，跳过 ${skipped} 组（已存在或超出上限），请确认后保存`
        );
    } catch (e: any) {
        ElMessage.error("服务识别出错：" + (e?.message ?? String(e)));
    } finally {
        discovering.value = false;
    }
};

// 表单验证规则
const formRules = reactive<FormRules>({
    projectId: [{ required: true, message: "请选择所属项目（可选「全部」）！", trigger: "change" }],
    name: [{ required: true, message: "请选择服务器名称！", trigger: "blur" }],
    os: [{ required: true, message: "请选择系统！", trigger: "blur" }],
    ip: [{ required: true, message: "请输入IP地址！", trigger: "blur" }],
    port: [{ required: true, message: "请输入端口！", trigger: "blur" }],
    account: [{ required: true, message: "请输入登录账号！", trigger: "blur" }],
    pwd: [{ required: true, message: "请输入登录密码！", trigger: "blur" }],
});

// 提交验证
const submitValidate = async (formEl: FormInstance | undefined) => {
    if (!formEl) return;
    await formEl.validate((valid, fields) => {
        if (valid) {
            onSubmit();
        } else {
            console.warn("未验证通过!", fields);
        }
    });
};

// 打开弹窗
const openDialog = async (type: string, row: RowServerType) => {
    /* Start: 重置表单内容 */
    state.ruleForm = getDefaultSubObject(state.ruleForm);
    // projectId 0 = 全部（所有项目可用），新增时默认；null 视为全部
    if (state.ruleForm.projectId == null) state.ruleForm.projectId = 0;
    if (state.ruleForm.os == 0) state.ruleForm.os = 1;
    if (state.ruleForm.port == 0) state.ruleForm.port = 22;
    if (!Array.isArray(state.ruleForm.defaultServerPaths)) state.ruleForm.defaultServerPaths = [];
    state.dialog.editId = null;
    state.dialog.type = "add";
    /* End: 重置表单内容 */
    await getProjectList();
    nextTick(() => {
        if (type === "edit") {
            state.dialog.type = "edit";
            state.dialog.editId = row.id;
            Object.assign(state.ruleForm, row);
            // 存量数据 project_id 为 null 的服务器按「全部」回显
            if (state.ruleForm.projectId == null) state.ruleForm.projectId = 0;
            if (!Array.isArray(state.ruleForm.defaultServerPaths)) state.ruleForm.defaultServerPaths = [];
            state.dialog.title = "修改服务器";
            state.dialog.submitTxt = "修改";
        } else {
            state.dialog.title = "新增服务器";
            state.dialog.submitTxt = "新增";
        }
        state.dialog.show = true;
    });
};

// 关闭弹窗
const closeDialog = () => {
    state.dialog.show = false;
};

// 取消
const onCancel = () => {
    closeDialog();
};

// 提交
const onSubmit = async () => {
    // 过滤掉服务标识与发布路径均为空的组
    state.ruleForm.defaultServerPaths = (state.ruleForm.defaultServerPaths || []).filter(
        (item) => (item.identity ?? "") !== "" || (item.path ?? "") !== ""
    );
    // projectId 0 = 全部，落库为 null（查询时按 project_id is null 带出）
    if (state.ruleForm.projectId === 0) state.ruleForm.projectId = null;
    if (state.dialog.type == "edit") {
        // 修改
        let updateResult = await serverDb.updateServer(state.ruleForm);
        if (updateResult.code === 0) {
            ElMessage.success("修改成功！");
            closeDialog(); // 关闭弹窗
            emit("refresh");
        } else {
            ElMessage.error(updateResult.msg);
        }
        return;
    }

    // 添加
    let insertResult = await serverDb.insertServer(state.ruleForm);
    if (insertResult.code === 0) {
        ElMessage.success("添加成功！");
        closeDialog(); // 关闭弹窗
        emit("refresh");
    } else {
        ElMessage.error(insertResult.msg);
    }
};

// 新增默认服务路径组
const addDefaultServerPath = () => {
    defaultServerPaths.value.push({ serviceType: null, identity: "", path: "" });
};

// 移除默认服务路径组
const removeDefaultServerPath = (index: number) => {
    defaultServerPaths.value.splice(index, 1);
};

// 查询项目信息
const getProjectList = async () => {
    let dataResult = await projectDb.getProjectList({
        code: null,
        name: null,
        sorting: "id DESC",
        skipCount: 0,
        maxResultCount: 1000,
    });
    if (dataResult.code !== 0) {
        ElMessage.error(dataResult.msg);
        return;
    }
    projectList.value = dataResult.data.data;
};

// 暴露变量
defineExpose({
    openDialog,
});
</script>
<style lang="scss" scoped>
.default-server-paths {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
}

.default-server-paths-actions {
    display: flex;
    align-items: center;
    gap: 10px;
}

.default-server-path-item {
    position: relative;
    width: 100%;
    border: 1px solid #dcdfe6;
    border-radius: 4px;
    padding: 8px 30px 8px 8px;

    .el-input+.el-input {
        margin-top: 5px;
    }

    .path-type-select {
        width: 100%;
        margin-bottom: 5px;
    }

    .path-remove {
        position: absolute;
        top: 7px;
        right: 7px;
        cursor: pointer;
    }
}
</style>
<style lang="scss">
.el-overlay .el-overlay-dialog .el-dialog .el-dialog__body {
    padding: 0px !important;
}
</style>
