<template>
    <div class="publish-container layout-padding">
        <!-- 顶部按钮 -->
        <div class="publish-card-box">
            <div v-for="fun in mainFunModules" :key="fun.title">
                <el-tooltip :content="fun.desc" placement="bottom" :show-after="300" effect="dark">
                    <div class="menu-item fun-hover" v-loading="fun.loading" :element-loading-text="fun.loadingText"
                        @click="onFunModuleHandle(fun.index)">
                        <div class="menu-item-icon">
                            <svg-icon :size="32" :name="fun.iconFont" :class="fun.iconFont"
                                :color="`var(${fun.iconColor})`" />
                        </div>
                        <div>{{ fun.title }}</div>
                    </div>
                </el-tooltip>
            </div>
            <!-- 更多功能：鼠标 hover 展开下拉菜单 -->
            <el-dropdown trigger="hover" placement="bottom-start" class="more-dropdown" @command="onMoreMenuCommand">
                <div class="menu-item fun-hover" v-loading="moreMenuLoading"
                    :element-loading-text="moreMenuLoadingText">
                    <div class="menu-item-icon">
                        <svg-icon :size="32" name="smom-icon smom-icon-xiangmuguanli"
                            :class="'smom-icon smom-icon-xiangmuguanli'" />
                    </div>
                    <div>更多功能</div>
                    <el-icon class="more-dropdown-arrow" :size="14">
                        <CaretBottom />
                    </el-icon>
                </div>
                <template #dropdown>
                    <el-dropdown-menu class="more-dropdown-menu">
                        <el-dropdown-item v-for="item in moreMenuItems" :key="item.title" :command="item.index"
                            :disabled="isAnyLoading" :title="item.desc">
                            <span class="menu-item">
                                <svg-icon :size="32" :name="item.iconFont" :class="item.iconFont"
                                    :color="`var(${item.iconColor})`" />
                                <div>{{ item.title }}</div>
                            </span>
                        </el-dropdown-item>
                    </el-dropdown-menu>
                </template>
            </el-dropdown>
        </div>

        <!-- 发布信息、日志信息 -->
        <div class="publish-card-config">
            <div class="publish-card-item">
                <div class="card-item-box">
                    <div class="card-title">
                        <div>发布信息<template v-if="appModuleList.length > 0">({{ appModuleList.length }})</template></div>
                        <div class="item-btn-box">
                            <el-button title="查看功能说明" size="small" type="primary" plain :icon="QuestionFilled"
                                @click="onOpenHelpDialog">功能说明</el-button>
                            <el-button title="修改应用配置" size="small" type="success" plain :icon="EditPen" :disabled="isAnyLoading ||
                                state.publishData.appconfigData.id == null ||
                                state.publishData.appconfigData.id <= 0
                                " @click="onOpenAppConfig">修改</el-button>
                            <el-button title="刷新|重置" size="small" type="info" plain :icon="Refresh"
                                :disabled="isAnyLoading"
                                @click="getProjectDefault({ keepCurrentEnvironment: true })">重置</el-button>
                        </div>
                    </div>
                    <div class="card-item-content">
                        <!-- 当前项目 -->
                        <div class="project-card">
                            <div class="project-select-row">
                                <div class="project-select-label">发布项目环境</div>
                                <el-select filterable placeholder="请选择要发布的项目" size="default"
                                    v-model="state.publishData.projectId" class="w100" :disabled="isAnyLoading"
                                    @change="onProjectChange">
                                    <el-option v-for="project in projectList" :key="project.id" :label="project.name"
                                        :value="project.id" />
                                </el-select>
                                <el-tag>{{ displayEnvironment(state.publishData.environment) }}</el-tag>
                            </div>
                        </div>

                        <div class="card-item-appconfig">
                            <table class="table-appconfig" cellpadding="0" cellspacing="0">
                                <tr class="table-head-row ">
                                    <th>程序集输出路径</th>
                                    <td>
                                        <a class="t-link-path" href="javascript:void(0);" title="打开程序集输出路径"
                                            @click="onOpenAssemblyOutPath(state.publishData.assemblyOutPath)"
                                            v-if="state.publishData.assemblyOutPath">{{
                                                state.publishData.assemblyOutPath
                                            }}</a>
                                        <label v-else>未配置，将采用默认路径</label>
                                    </td>
                                </tr>
                                <tr class="table-head-row ">
                                    <th>
                                        <div class="th-with-tip">
                                            <span>最新时间阈值</span>
                                            <el-tooltip placement="top"
                                                content="获取/上传程序集前，检查本机程序集目录最新文件修改时间是否在该阈值内；超过则提示确认是否继续（防止拿了旧程序集就发布）">
                                                <el-icon class="th-tip-icon">
                                                    <ele-QuestionFilled />
                                                </el-icon>
                                            </el-tooltip>
                                        </div>
                                    </th>
                                    <td>
                                        <div class="recent-minutes-row">
                                            <el-input-number v-model="recentMinutes" :min="1" :max="1440" size="small"
                                                @change="saveRecentMinutesToStorage" />
                                            <label>分钟</label>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </div>
                        <div class="card-item-appconfig" v-if="state.publishData.appconfigData.dllMode">
                            <table class="table-appconfig" cellpadding="0" cellspacing="0">
                                <tr class="table-head-row ">
                                    <th>获取dll方式</th>
                                    <td colspan="3">{{ showDllMode() }}</td>
                                </tr>
                                <tr
                                    v-show="state.publishData.appconfigData.dllMode == 'TFS' || state.publishData.appconfigData.dllMode == 'Git'">
                                    <th>生成发布日志</th>
                                    <td>
                                        <el-switch v-model="generatePublishLog.isEnable" :active-value="true"
                                            :inactive-value="false" :disabled="isAnyLoading" inline-prompt
                                            active-text="开启" inactive-text="关闭" size="default" />
                                    </td>
                                    <th v-show="generatePublishLog.isEnable">生成方式</th>
                                    <td v-show="generatePublishLog.isEnable">
                                        <el-select v-model="generatePublishLog.type" :disabled="isAnyLoading"
                                            placeholder="请选择生成方式" size="default" style="min-width: 50px">
                                            <el-option label="默认" value="默认" />
                                            <el-option label="仅发布内容" value="仅发布内容" />
                                            <el-option label="按日期" value="按日期" />
                                            <el-option label="按用户" value="按用户" />
                                        </el-select>
                                    </td>
                                </tr>
                                <tr v-show="(state.publishData.appconfigData.dllMode == 'TFS' || state.publishData.appconfigData.dllMode == 'Git') &&
                                    generatePublishLog.type !== '仅发布内容' &&
                                    generatePublishLog.isEnable
                                    ">
                                    <th>生成信息(包含)</th>
                                    <td colspan="3">
                                        <el-checkbox v-model="generatePublishLog.displayPublishField.isChangeSet"
                                            :disabled="isAnyLoading" size="default" label="变更集" />
                                        <el-checkbox v-model="generatePublishLog.displayPublishField.isDateTime"
                                            :disabled="isAnyLoading" size="default" label="日期" />
                                        <el-checkbox v-model="generatePublishLog.displayPublishField.isUser"
                                            :disabled="isAnyLoading" size="default" label="用户" />
                                        <el-checkbox v-model="generatePublishLog.displayPublishField.isDll"
                                            :disabled="isAnyLoading" size="default" label="DLL" />
                                    </td>
                                </tr>
                            </table>
                        </div>
                        <div class="card-item-appconfig">
                            <table v-for="mod in appModuleList" :key="mod.key" class="table-appconfig"
                                :class="{ 'mb15': !mod.isLast }" cellpadding="0" cellspacing="0">
                                <tr class="table-head-row ">
                                    <th>应用类型</th>
                                    <td>
                                        <div class="server-type-row">
                                            <div>{{ mod.name }}</div>
                                            <div>
                                                <el-button type="danger" :icon="CloseBold" circle size="small"
                                                    title="移除模块，让其暂时不参与功能操作，重置可恢复" :disabled="isAnyLoading"
                                                    @click="mod.mod.clientPath = ''" style="font-size: 1.2rem;" />
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <th>客户端生成路径</th>
                                    <td>
                                        <a class="t-link-path" href="javascript:void(0);" title="打开客户端生成路径"
                                            @click="onOpenClientPath(mod.mod.clientPath as string)">{{
                                                mod.mod.clientPath
                                            }}</a>
                                    </td>
                                </tr>
                                <!-- WpfClient 特有：生成目录与打包信息 -->
                                <template v-if="mod.key === 'wpfClient'">
                                    <tr>
                                        <th>生成的目录</th>
                                        <td>{{ showGenerateDir(String((mod.mod as
                                            WpfClientConfigType).generateDirJson)) }}</td>
                                    </tr>
                                    <tr>
                                        <th>是否打包(压缩)</th>
                                        <td>{{ (mod.mod as WpfClientConfigType).isCompress == 1 ? "是" : "否" }}</td>
                                    </tr>
                                    <tr v-if="(mod.mod as WpfClientConfigType).isCompress == 1">
                                        <th>打包(压缩)文件</th>
                                        <td>{{ showCompressFile(String((mod.mod as
                                            WpfClientConfigType).compressFileJson)) }}</td>
                                    </tr>
                                </template>
                                <template v-for="(server, sIndex) in mod.mod.serverArr" :key="sIndex">
                                    <tr>
                                        <th colspan="2" class="t-align-c">{{ server.name }}</th>
                                    </tr>
                                    <tr>
                                        <td colspan="2" class="t-align-c">
                                            <table
                                                class="table-appconfig table-appconfig-shadow-none mt10 mb10 t-border-none"
                                                cellpadding="0" cellspacing="0"
                                                v-for="(serverVal, valIndex) in getServerValues(server)"
                                                :key="valIndex">
                                                <tr v-if="mod.key !== 'wpfClient'">
                                                    <th>服务标识</th>
                                                    <td>{{ serverVal.identity }}</td>
                                                </tr>
                                                <tr>
                                                    <th>发布路径</th>
                                                    <td>{{ serverVal.path }}</td>
                                                </tr>
                                            </table>
                                        </td>
                                    </tr>
                                </template>
                            </table>
                            <el-empty description="无应用配置信息." v-show="showEmptyAppConfig" :image-size="150" />
                        </div>
                    </div>
                </div>
            </div>
            <div style="width: 1rem;"></div>
            <div class="publish-card-item">
                <div class="card-item-box">
                    <div class="card-title">
                        <div>日志信息</div>
                        <div class="item-btn-box">
                            <el-button title="停止当前功能（立即停止后续操作）" size="small" type="danger" plain
                                :disabled="!isAnyLoading" @click="onStopFunModule">
                                <el-icon style="margin-right: 4px">
                                    <VideoPause />
                                </el-icon>停止
                            </el-button>
                            <el-button title="清空日志" size="small" type="info" plain :icon="CircleClose"
                                @click="onRemoveLogs">清空日志</el-button>
                        </div>
                    </div>
                    <div class="card-item-content log-content">
                        <el-tabs v-model="activeLogTab" type="border-card" class="log-tabs"
                            :class="{ 'log-tabs-single': displayTabs.length <= 1 }">
                            <el-tab-pane v-for="tab in displayTabs" :key="tab.id" :name="tab.id">
                                <template #label>
                                    <span>
                                        <span v-if="tab.status === 'running'"
                                            style="color: var(--el-color-warning)">●</span>
                                        <span v-else-if="tab.status === 'success'"
                                            style="color: var(--el-color-success)">●</span>
                                        <span v-else-if="tab.status === 'error'"
                                            style="color: var(--el-color-danger)">●</span>
                                        <span v-else style="color: var(--el-color-info)">●</span>
                                        {{ tab.label }}
                                    </span>
                                </template>
                                <div :ref="(el: any) => setTabContentRef(tab.id, el)" class="log-tab-pane-content">
                                    <p v-for="logLine in tab.logs" :class="logLine.type">
                                        {{ logLine.content.value }}
                                        <el-text type="primary" size="small"
                                            v-if="logLine.content.uploadFile?.progressText">{{
                                                logLine.content.uploadFile.progressText }}</el-text>
                                        <el-text :type="logLine.content.uploadFile.currNumber >=
                                            logLine.content.uploadFile.totalNumber
                                            ? 'primary'
                                            : 'warning'
                                            " size="small"
                                            v-else-if="logLine.content.uploadFile && logLine.content.uploadFile.totalNumber > 0">{{
                                                logLine.content.uploadFile.prefix
                                            }}{{ logLine.content.uploadFile.currNumber }}/{{
                                                logLine.content.uploadFile.totalNumber
                                            }}
                                            个文件。</el-text>
                                    </p>
                                </div>
                            </el-tab-pane>
                        </el-tabs>
                    </div>
                </div>
            </div>
        </div>

        <!-- 服务管理对话框 -->
        <el-dialog v-model="serviceStatusVisible" title="服务管理" width="1080px" draggable>
            <div class="status-batch-bar">
                <el-button size="small" type="danger" plain
                    :disabled="!selectedStatusRows.length || serviceStatusOperating"
                    @click="onBatchControlService('stop')">批量停止</el-button>
                <el-button size="small" type="primary" plain
                    :disabled="!selectedStatusRows.length || serviceStatusOperating"
                    @click="onBatchControlService('start')">批量启动</el-button>
                <el-button size="small" type="warning" plain
                    :disabled="!selectedStatusRows.length || serviceStatusOperating"
                    @click="onBatchControlService('restart')">批量重启</el-button>
                <el-button size="small" type="danger" text :icon="VideoPause" :disabled="!isDialogOperating"
                    title="停止当前查询/服务操作" @click="onStopDialogOp">停止</el-button>
                <span class="status-batch-tip">勾选后可批量操作；操作日志记录在「总体日志」中</span>
            </div>
            <el-table :data="serviceStatusRows" size="default" border v-loading="serviceStatusLoading"
                class="status-table" @selection-change="onStatusSelectionChange">
                <el-table-column type="selection" width="45" :selectable="canOperateStatusRow" />
                <el-table-column type="index" label="序号" width="60" />
                <el-table-column prop="module" label="应用类型" width="130" />
                <el-table-column prop="serverName" label="服务器" min-width="120" />
                <el-table-column prop="identity" label="服务标识" min-width="250" />
                <el-table-column label="状态" width="100">
                    <template #default="scope">
                        <el-tag v-if="scope.row.running === true" type="success">运行中</el-tag>
                        <el-tag v-else-if="scope.row.running === false" type="danger">已停止</el-tag>
                        <el-tag v-else type="info">{{ scope.row.statusText }}</el-tag>
                    </template>
                </el-table-column>
                <el-table-column label="操作" width="200">
                    <template #default="scope">
                        <el-button size="small" type="danger"
                            :disabled="!canOperateStatusRow(scope.row) || serviceStatusOperating"
                            @click="onControlService(scope.row, 'stop')">停止</el-button>
                        <el-button size="small" type="primary"
                            :disabled="!canOperateStatusRow(scope.row) || serviceStatusOperating"
                            @click="onControlService(scope.row, 'start')">启动</el-button>
                        <el-button size="small" type="warning"
                            :disabled="!canOperateStatusRow(scope.row) || serviceStatusOperating"
                            @click="onControlService(scope.row, 'restart')">重启</el-button>
                    </template>
                </el-table-column>
            </el-table>
            <template #footer>
                <el-button @click="serviceStatusVisible = false">关 闭</el-button>
            </template>
        </el-dialog>

        <!-- 程序集信息对话框（服务端程序集 / 本机程序集） -->
        <el-dialog v-model="stagingVisible" :title="stagingTitle" width="1080px" draggable>
            <el-alert v-if="stagingErrorMsg" :title="stagingErrorMsg" type="warning" show-icon :closable="false"
                style="margin-bottom: 10px" />
            <el-table :data="stagingRows" size="default" border v-loading="stagingLoading" class="staging-table">
                <el-table-column type="index" label="序号" width="60" />
                <el-table-column prop="serverName" label="服务器" min-width="130" />
                <el-table-column prop="moduleName" label="模块目录" min-width="140" />
                <el-table-column prop="latestFileName" label="最新文件名" min-width="200" />
                <el-table-column prop="latestFileTime" label="最新文件时间" min-width="165" />
                <el-table-column prop="oldestFileName" label="最旧文件名" min-width="200" />
                <el-table-column prop="oldestFileTime" label="最旧文件时间" min-width="165" />
            </el-table>
            <template #footer>
                <el-button type="danger" plain size="small" :icon="VideoPause" :disabled="!stagingLoading"
                    title="停止当前查询" @click="onStopDialogOp">停止</el-button>
                <el-button @click="stagingVisible = false">关 闭</el-button>
            </template>
        </el-dialog>

        <!-- 核对程序集对话框（以本机为准，逐文件比对各服务器暂存程序集） -->
        <el-dialog v-model="checkVisible" title="核对程序集" width="1080px" draggable>
            <el-alert v-if="checkErrorMsg" :title="checkErrorMsg" type="warning" show-icon :closable="false"
                style="margin-bottom: 10px" />
            <div class="check-toolbar">
                <el-switch v-model="checkOnlyDiff" active-text="仅看差异" inactive-text="显示全部" />
                <span class="check-summary" v-if="checkRows.length > 0">
                    共 {{ checkRows.length }} 项：一致 {{checkRows.filter((row) => row.consistent).length}} 项，差异
                    {{checkRows.filter((row) => !row.consistent).length}} 项
                </span>
            </div>
            <el-table :data="checkDisplayRows" size="default" border v-loading="checkLoading" class="staging-table"
                :row-key="(row: AssemblyDiffRow) => `${row.serverId}-${row.moduleName}`">
                <el-table-column type="expand">
                    <template #default="{ row }">
                        <div class="check-detail" v-if="row.details.length > 0">
                            <div v-for="(detail, i) in row.details" :key="i" class="check-detail-item">
                                <el-tag :type="checkDiffTagType(detail.type)" size="small">{{ checkDiffText(detail.type)
                                }}</el-tag>
                                <span class="check-detail-file">{{ detail.file }}</span>
                                <span class="check-detail-time">本地：{{ detail.localTime }}　服务器：{{ detail.serverTime
                                }}</span>
                            </div>
                        </div>
                        <div v-else class="check-detail-empty">无差异明细</div>
                    </template>
                </el-table-column>
                <el-table-column type="index" label="序号" width="60" />
                <el-table-column prop="serverName" label="服务器" min-width="130" />
                <el-table-column prop="moduleName" label="模块目录" min-width="140" />
                <el-table-column prop="localCount" label="本地文件数" width="95" align="center" />
                <el-table-column prop="serverCount" label="服务器文件数" width="110" align="center" />
                <el-table-column prop="missingCount" label="缺失" width="75" align="center" />
                <el-table-column prop="timeDiffCount" label="时间不一致" width="100" align="center" />
                <el-table-column prop="extraCount" label="服务器多出" width="100" align="center" />
                <el-table-column label="差异合计" width="100" align="center">
                    <template #default="{ row }">
                        <el-tag v-if="row.consistent" type="success" size="small">一致</el-tag>
                        <el-tag v-else type="danger" size="small">{{ row.diffCount }}</el-tag>
                    </template>
                </el-table-column>
            </el-table>
            <template #footer>
                <el-button type="danger" plain size="small" :icon="VideoPause" :disabled="!checkLoading" title="停止当前核对"
                    @click="onStopDialogOp">停止</el-button>
                <el-button @click="checkVisible = false">关 闭</el-button>
            </template>
        </el-dialog>

        <!-- 服务备份对话框 -->
        <el-dialog v-model="backupVisible" title="服务备份" width="1080px" draggable>
            <el-alert v-if="backupErrorMsg" :title="backupErrorMsg" type="warning" show-icon :closable="false"
                style="margin-bottom: 10px" />
            <el-table :data="backupRows" size="default" border v-loading="backupLoading" class="staging-table">
                <el-table-column type="index" label="序号" width="60" />
                <el-table-column prop="serverName" label="服务器" min-width="110" />
                <el-table-column prop="backupDate" label="文件夹名称" min-width="110" />
                <el-table-column prop="backupTime" label="备份时间" min-width="150" />
                <el-table-column prop="serviceCount" label="服务数" width="70" />
                <el-table-column label="备份服务明细" min-width="300">
                    <template #default="scope">
                        <span>{{ scope.row.services.join("、") || "（无）" }}</span>
                    </template>
                </el-table-column>
                <el-table-column label="操作" width="140" fixed="right">
                    <template #default="scope">
                        <el-button size="small" type="warning" plain :disabled="backupDeleting || backupRestoring"
                            @click="onRestoreServiceBackup(scope.row)">恢复</el-button>
                        <el-button size="small" type="danger" plain :disabled="backupDeleting || backupRestoring"
                            @click="onDeleteServiceBackup(scope.row)">删除</el-button>
                    </template>
                </el-table-column>
            </el-table>
            <template #footer>
                <el-button type="danger" plain size="small" :icon="VideoPause" :disabled="!isBackupOperating"
                    title="停止当前查询/删除/恢复操作" @click="onStopDialogOp">停止</el-button>
                <el-button @click="backupVisible = false">关 闭</el-button>
            </template>
        </el-dialog>

        <!-- 恢复服务备份对话框 -->
        <restore-backup-dialog v-model="restoreVisible" :server-name="restoreServerName" :folders="restoreFolders"
            :services="restoreServices" :loading="backupRestoring" @restore="onRestoreBackup" @stop="onStopDialogOp" />

        <appconfig-dialog ref="appconfigDialogRef" @environment-change="onAppConfigEnvChange"
            @project-change="onAppConfigProjectChange" @refresh="getPublishAppconfigs()" />

        <!-- 功能说明对话框 -->
        <help-dialog ref="helpDialogRef" />
    </div>
</template>

<script setup lang="ts" name="publishStep">
import {
    reactive,
    ref,
    computed,
    onBeforeMount,
    defineAsyncComponent,
} from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Refresh, CircleClose, EditPen, VideoPause, QuestionFilled, CaretBottom, CloseBold } from "@element-plus/icons-vue";
import { cmdInvoke } from "@/utils/command";
import { path } from "@tauri-apps/api";
import { useProjectDb } from "@/database/project/index";
import { useAppconfigDb } from "@/database/appconfig/index";
import {
    displayEnvironment,
    removeSlash,
    getDefaultSubObject,
} from "@/utils/other";
import { loadPublishSettings } from "@/utils/publishSettings";
import { useStepLog } from "@/composables/useStepLog";
import {
    useStepPublish,
    type ServiceStatusRow,
    type StagingAssemblyRow,
    type AssemblyDiffRow,
    type ServiceBackupRow,
} from "@/composables/useStepPublish";

// 日志组合式函数
const stepLogApi = useStepLog();

const {
    activeLogTab,
    displayTabs,
    setTabContentRef,
    printInfoLog,
    onRemoveLogs,
    initLogs,
} = stepLogApi;

// 引入组件
const appconfigDialogRef = ref();
const AppconfigDialog = defineAsyncComponent(
    () => import("@/views/appconfig/components/appconfigDialog.vue")
);
const helpDialogRef = ref();
const HelpDialog = defineAsyncComponent(
    () => import("./components/helpDialog.vue")
);
const RestoreBackupDialog = defineAsyncComponent(
    () => import("./components/restoreBackupDialog.vue")
);

// 查看功能说明
const onOpenHelpDialog = () => {
    helpDialogRef.value.openDialog();
};

// 定义变量内容
const projectList = ref<RowProjectType[]>();
const showEmptyAppConfig = ref(false);
const webApiHostName = ref("WebApiHost");
const scheduleServerName = ref("ScheduleServer");
const webClientName = ref("WebClient");
const wpfClientName = ref("WpfClient");
const spcMonitorName = ref("SpcMonitor");

// ==================== 发布信息卡：应用类型模块 ====================
// 五种应用类型配置结构一致（clientPath + serverArr），抽取成列表循环渲染；
// wpfClient 的额外行（生成目录/打包）在模板内用 key 区分
const appModuleList = computed(() => {
    const items = state.publishData.appconfigData.configItems;
    if (!items) return [];
    const defs: {
        key: "webApiHost" | "webClient" | "scheduleServer" | "wpfClient" | "spcMonitor";
        name: string;
    }[] = [
            { key: "webApiHost", name: webApiHostName.value },
            { key: "webClient", name: webClientName.value },
            { key: "scheduleServer", name: scheduleServerName.value },
            { key: "wpfClient", name: wpfClientName.value },
            { key: "spcMonitor", name: spcMonitorName.value },
        ];
    return defs
        .map((d) => ({ ...d, mod: items[d.key] }))
        .filter((d) => !!d.mod?.clientPath)
        .map((d, index, arr) => ({ ...d, isLast: index === arr.length - 1 }));
});
// 服务的全部发布路径（把 serverPathArr[].value 拍平，供模板单层循环）
const getServerValues = (server: SelectServerType) =>
    (server.serverPathArr || []).flatMap((sp) => sp.value || []);
const projectAssemblyOutPath = ref("");
const generatePublishLog = ref({
    isEnable: true,
    type: "默认",
    displayPublishField: {
        isChangeSet: true,
        isUser: true,
        isDateTime: true,
        isDll: true,
    } as DisplayPublishFieldType,
    data: "",
    logs: "",
});
const projectDb = useProjectDb();
const appconfigDb = useAppconfigDb();

const state = reactive({
    funModule: [
        {
            title: "获取程序集",
            desc: "按 TFS/Git 变更或 DLL 名称等配置，把要发布的文件复制到本机程序集输出路径",
            iconBgColor: "--next-color-warning-lighter",
            iconFont: "smom-icon smom-icon-chengxuji",
            iconColor: "--el-color-warning",
            loading: false,
            loadingText: "获取中",
        },
        {
            title: "打包WPF",
            desc: "下载远程 WPF 压缩包，合并本地生成目录后重新打包并更新 Manifest.xml 版本号（仅打包到本地）",
            iconBgColor: "--next-color-warning-lighter",
            iconFont: "smom-icon smom-icon-appconfig",
            iconColor: "--el-color-warning",
            loading: false,
            loadingText: "打包中",
        },
        {
            title: "查看服务端程序集",
            desc: "查看各服务器程序集暂存路径下，各模块最新/最旧文件及修改时间",
            iconBgColor: "--next-color-primary-lighter",
            iconFont: "smom-icon smom-icon-chengxuji",
            iconColor: "--el-color-primary",
            loading: false,
            loadingText: "查询中",
        },
        {
            title: "查看本机程序集",
            desc: "查看本机程序集输出路径下，各模块最新/最旧文件及修改时间",
            iconBgColor: "--next-color-primary-lighter",
            iconFont: "smom-icon smom-icon-chengxuji",
            iconColor: "--el-color-primary",
            loading: false,
            loadingText: "查询中",
        },
        {
            title: "上传程序集",
            desc: "把本机程序集上传到各服务器的程序集暂存路径，供发布使用",
            iconBgColor: "--next-color-primary-lighter",
            iconFont: "smom-icon smom-icon-shangchuanfabu",
            iconColor: "--el-color-primary",
            loading: false,
            loadingText: "上传中",
        },
        {
            title: "核对程序集",
            desc: "以本机程序集为准，逐文件比对各服务器暂存程序集的修改时间，统计差异项",
            iconBgColor: "--next-color-danger-lighter",
            iconFont: "smom-icon smom-icon-chengxuji",
            iconColor: "--el-color-danger",
            loading: false,
            loadingText: "核对中",
        },
        {
            title: "发布",
            desc: "逐个服务执行：停止服务 → 用暂存程序集替换发布目录 → 启动服务",
            iconBgColor: "--next-color-success-lighter",
            iconFont: "smom-icon smom-icon-fabu",
            iconColor: "--el-color-success",
            loading: false,
            loadingText: "发布中",
        },
        {
            title: "备份",
            desc: "发布前把各服务目录整目录备份到服务器的服务备份路径（按年月日时分文件夹存放）",
            iconBgColor: "--next-color-success-lighter",
            iconFont: "smom-icon smom-icon-beifenjilu",
            iconColor: "--el-color-success",
            loading: false,
            loadingText: "备份中",
        },
        {
            title: "备份管理",
            desc: "查看每台服务器备份目录中前 10 个备份文件夹及服务明细，支持[删除、恢复]指定备份",
            iconBgColor: "--next-color-danger-lighter",
            iconFont: "smom-icon smom-icon-beifenjilu",
            iconColor: "--el-color-danger",
            loading: false,
            loadingText: "查询中",
        },
        {
            title: "服务管理",
            desc: "查看各服务运行状态，支持单行或批量的[停止、启动、重启]",
            iconBgColor: "--next-color-danger-lighter",
            iconFont: "smom-icon smom-icon-fuwuqi",
            iconColor: "--el-color-danger",
            loading: false,
            loadingText: "查询中",
        },
    ],
    // 项目发布信息
    publishData: {
        projectId: null as any,
        projectName: "",
        assemblyOutPath: "",
        environment: 1 as number,
        appconfigData: {} as RowAppconfigType,
    },
});

// 是否有模块正在执行
const isAnyLoading = computed(() => state.funModule.some((item) => item.loading));
const currModuleIndex = ref(0);

// ==================== 更多功能下拉菜单 ====================
// 收纳进「更多功能」菜单的功能标题（顶部不再平铺展示）
const moreMenuTitles = ["备份", "备份管理", "服务管理", "查看服务端程序集", "查看本机程序集"];
// 顶部平铺卡片：排除收纳进菜单的功能
const mainFunModules = computed(() =>
    state.funModule
        .map((item, index) => ({ ...item, index }))
        .filter((item) => !moreMenuTitles.includes(item.title))
);
// 菜单项（携带在原 funModule 数组中的索引，供点击回调使用）
const moreMenuItems = computed(() =>
    state.funModule
        .map((item, index) => ({ ...item, index }))
        .filter((item) => moreMenuTitles.includes(item.title))
);
// 更多功能卡片 loading：任一子功能执行中即显示
const moreMenuLoading = computed(() => moreMenuItems.value.some((item) => item.loading));
const moreMenuLoadingText = computed(
    () => moreMenuItems.value.find((item) => item.loading)?.loadingText || ""
);
// 菜单点击 → 复用功能模块触发逻辑（索引对应原 funModule 数组）
const onMoreMenuCommand = (index: number) => {
    onFunModuleHandle(index);
};

// STEP 业务组合式函数
const stepPublishApi = useStepPublish(
    {
        projectId: () => state.publishData.projectId,
        projectName: () => state.publishData.projectName,
        environment: () => state.publishData.environment,
        appconfigData: () => state.publishData.appconfigData,
        assemblyOutPath: () => projectAssemblyOutPath.value,
    },
    stepLogApi
);

// 应用配置弹框环境变更
const onAppConfigEnvChange = (newEnv: number) => {
    state.publishData.environment = newEnv;
};

// 应用配置弹框项目变更（弹窗内切换项目管理后保存时同步到发布信息）
const onAppConfigProjectChange = (newProjectId: any) => {
    const projectId = Number(newProjectId);
    if (!projectId || projectId === state.publishData.projectId) return;
    const projectObj = projectList.value?.find((item) => item.id === projectId);
    if (projectObj) {
        state.publishData.projectName = String(projectObj.name);
        state.publishData.assemblyOutPath = projectObj.assemblyOutPath ? String(projectObj.assemblyOutPath) : "";
    }
    state.publishData.projectId = projectId;
    saveProjectIdToStorage(projectId);
};

// 停止当前正在执行的功能（获取程序集/打包wpf/上传程序集/发布/备份服务）
const onStopFunModule = () => {
    if (!isAnyLoading.value) return;
    stepPublishApi.requestStop();
    ElMessage.info("已发出停止请求，正在立即停止.");
};

// 获取程序集前检查：客户端生成路径下是否存在 10 分钟内修改的文件
// 没有时提示各路径最新文件修改时间，让用户决定是否继续，返回是否继续
// 获取/上传程序集前检查：本机程序集路径下是否存在 10 分钟内修改的文件（与获取/上传的目标目录一致）
// 没有时提示各路径最新文件修改时间，让用户决定是否继续，返回是否继续
const checkClientPathRecentFiles = async (opTitle: string): Promise<boolean> => {
    const modules = appModuleList.value.filter((mod) => mod.mod?.clientPath);
    if (modules.length < 1) return true;
    let outPath = "";
    try {
        outPath = removeSlash(await getProjectOutPath());
    } catch (error) {
        console.error("获取本机程序集路径失败:", error);
        // 路径异常时不阻断流程，按有文件处理
        return true;
    }
    const recentBefore = new Date().getTime() - Math.max(1, Number(recentMinutes.value) || 10) * 60 * 1000;
    // 逐个模块读取本机程序集目录下最新文件修改时间
    // WpfClient 按操作与产物结构区分：
    //   获取程序集 → 产物在 <输出路径>；
    //   上传程序集 → 上传目标是 packOutput（打包WPF后才存在），检查其一级文件（各 zip + Manifest.xml）
    //   打包WPF -> 产物在 <输出路径>/[生成的目录]
    const latestTexts = new Array<string>();
    try {
        for (const mod of modules) {
            // 本模块待检查的目录清单（label, dir）
            const checkDirs: { label: string; dir: string }[] = [];
            if (opTitle === "获取程序集"){
                checkDirs.push({ label: mod.name, dir: `${mod.mod.clientPath}` });
            }
            if (opTitle === "上传程序集") {
                if (mod.key === "wpfClient") {
                    checkDirs.push({ label: mod.name, dir: `${outPath}/${mod.name}/packOutput` });
                } 
                else {
                    checkDirs.push({ label: mod.name, dir: `${outPath}/${mod.name}` });
                }
            }
            if (opTitle === "打包WPF" && mod.key === "wpfClient") {
                const generateDirs = JSON.parse(String((mod.mod as WpfClientConfigType).generateDirJson)) as string[];
                for (const generateDir of generateDirs) {
                    checkDirs.push({ label: mod.name, dir: `${outPath}/${mod.name}/${generateDir}` });
                }
            }
           
            let hasRecentInModule = false;
            const moduleTexts = new Array<string>();
            for (const checkDir of checkDirs) {
                const result = await cmdInvoke<string>("read_latest_mtime", {
                    dir: checkDir.dir,
                });
                const latestMtime = result.code === 0 ? String(result.data || "") : "";
                moduleTexts.push(`${checkDir.label}：${latestMtime || "（无文件）"}`);
                // 最新修改时间在阈值内即视为有新构建产物
                if (latestMtime && new Date(latestMtime.replace(/-/g, "/")).getTime() >= recentBefore) {
                    hasRecentInModule = true;
                }
            }
            latestTexts.push(...moduleTexts);
            if (hasRecentInModule) return true;
        }
    } catch (error) {
        console.error("检查本机程序集最近文件失败:", error);
        // 检查异常时不阻断流程，按有文件处理
        return true;
    }
    try {
        await ElMessageBox.confirm(
            `本机程序集路径下未发现 ${recentMinutes.value} 分钟内修改的文件，可能尚未编译/获取最新。<br/><br/>${latestTexts.map((t) => `· ${t}`).join("<br/>")}<br/><br/>是否继续${opTitle}？`,
            `${opTitle}确认`,
            {
                confirmButtonText: `继续${opTitle}`,
                cancelButtonText: "取消",
                dangerouslyUseHTMLString: true,
                type: "warning",
            }
        );
        return true;
    } catch {
        return false;
    }
};

// 功能模块触发
const onFunModuleHandle = async (index: number) => {
    const title = state.funModule[index].title;
    if (showEmptyAppConfig.value) {
        ElMessage.warning("未获取到要发布的应用配置信息！");
        return;
    }
    const currModule = state.funModule.find((item) => item.loading);
    if (currModule) {
        ElMessage.info(`正在[${currModule.title}]中，请稍等！`);
        return;
    }

    // 查看类按钮：打开对话框展示，不写发布日志
    if (title === "服务管理") {
        await onShowServiceStatus(index);
        return;
    }
    if (title === "查看服务端程序集") {
        await onShowAssemblyInfo(index, "server");
        return;
    }
    if (title === "查看本机程序集") {
        await onShowAssemblyInfo(index, "local");
        return;
    }
    if (title === "核对程序集") {
        await onShowAssemblyCheck(index);
        return;
    }
    if (title === "备份管理") {
        await onShowServiceBackups(index);
        return;
    }

    // 发布前二次确认
    if (title === "发布") {
        try {
            await ElMessageBox.confirm(
                "发布将按服务实例执行：停止服务 → 用程序集暂存路径的内容替换服务发布路径 → 开启服务。<br/><br/>建议发布前先执行【备份】！是否继续？",
                "发布确认",
                {
                    confirmButtonText: "开始发布",
                    cancelButtonText: "取消",
                    dangerouslyUseHTMLString: true,
                    type: "warning",
                }
            );
        } catch {
            return;
        }
    }

    // 获取程序集/上传程序集前：检查本机程序集路径（获取/上传的目标目录）下是否有 10 分钟内修改的文件，
    // 没有则可能尚未完成构建，让用户决定是否继续
    if (title === "获取程序集" || title === "上传程序集" || title === "打包WPF") {
        if (!(await checkClientPathRecentFiles(title))) return;
    }

    onRemoveLogs();
    state.funModule[index].loading = true;
    currModuleIndex.value = index;
    initLogs(state.publishData.projectName, displayEnvironment(state.publishData.environment));

    // 加载发布设置缓存（供 copy/服务启停/上传 的 getRetryArgs 使用）
    await loadPublishSettings();
    projectAssemblyOutPath.value = await getProjectOutPath();

    let isSuccess = false;
    try {
        isSuccess = await executeFunModule(title);
    } finally {
        printInfoLog("");
        state.funModule[index].loading = false;
        // 功能运行结束后复位停止标记，避免残留的后端取消标记影响后续对话框操作
        stepPublishApi.resetStopState();
    }
    if (isSuccess) {
        if (title === "获取程序集") printInfoLog("获取程序集成功。");
        if (title === "备份") printInfoLog("备份成功。");
        if (title === "打包WPF") printInfoLog("打包WPF成功。");
        if (title === "上传程序集") printInfoLog("上传程序集成功。");
        if (title === "发布") printInfoLog("发布成功。");
    }
};

// 执行功能模块（界面按钮共用），返回是否成功
const executeFunModule = async (title: string): Promise<boolean> => {
    switch (title) {
        case "获取程序集": {
            if (!(await stepPublishApi.validateTfsLocalPath())) return false;
            return await stepPublishApi.getApplicationAssemblys(false);
        }
        case "备份":
            return await stepPublishApi.backupServices();
        case "打包WPF":
            return await stepPublishApi.packWpfClient();
        case "上传程序集":
            return await stepPublishApi.uploadAssemblies();
        case "发布":
            return await stepPublishApi.stepPublish();
        default:
            return false;
    }
};

// 服务管理
const serviceStatusVisible = ref(false);
const serviceStatusLoading = ref(false);
const serviceStatusRows = ref<ServiceStatusRow[]>([]);
// 服务操作（停止/启动/重启）
const serviceStatusOperating = ref(false);
const selectedStatusRows = ref<ServiceStatusRow[]>([]);
const onStatusSelectionChange = (rows: ServiceStatusRow[]) => {
    selectedStatusRows.value = rows;
};
// 仅状态已知（运行中/已停止）的行可操作
const canOperateStatusRow = (row: ServiceStatusRow) => {
    return Boolean(row.serverId) && row.running !== null;
};
const statusActionText: Record<string, string> = { stop: "停止", start: "启动", restart: "重启" };
const runControlService = async (rows: ServiceStatusRow[], action: "stop" | "start" | "restart") => {
    const validRows = rows.filter((row) => canOperateStatusRow(row));
    if (validRows.length < 1) {
        ElMessage.warning("所选服务状态未知或未找到，无法操作.");
        return;
    }
    const skippedCount = rows.length - validRows.length;
    const confirmMessage =
        `确认对 ${validRows.length} 个服务执行[${statusActionText[action]}]操作？` +
        (skippedCount > 0 ? `\n（另有 ${skippedCount} 个状态未知的服务将被跳过）` : "");
    try {
        await ElMessageBox.confirm(confirmMessage, "服务操作确认", { type: "warning" });
    } catch {
        return; // 用户取消
    }
    // 复位停止标记（清除上次停止残留的后端取消标记），使本次操作可正常执行且支持停止
    stepPublishApi.resetStopState();
    serviceStatusOperating.value = true;
    try {
        let failCount = 0;
        let stopBreak = false;
        for (const row of validRows) {
            if (stepPublishApi.checkStop()) {
                stopBreak = true;
                break;
            }
            const ok = await stepPublishApi.controlService(row, action);
            if (!ok) failCount++;
        }
        // 操作完成后刷新状态（已手动停止时跳过刷新，避免查询被立即中止）
        if (!stopBreak) {
            const refreshResult = await stepPublishApi.getServiceStatuses();
            serviceStatusRows.value = refreshResult.data || [];
            selectedStatusRows.value = [];
        }
        if (stopBreak) {
            ElMessage.warning(`${statusActionText[action]}已手动停止，剩余服务操作已中止，详见「总体日志」`);
        } else if (failCount > 0) {
            ElMessage.error(`${statusActionText[action]}完成：${validRows.length - failCount} 个成功，${failCount} 个失败，详见「总体日志」`);
        } else {
            ElMessage.success(`${validRows.length} 个服务${statusActionText[action]}操作全部成功`);
        }
    } finally {
        serviceStatusOperating.value = false;
    }
};
const onControlService = (row: ServiceStatusRow, action: "stop" | "start" | "restart") => {
    runControlService([row], action);
};
const onBatchControlService = (action: "stop" | "start" | "restart") => {
    runControlService(selectedStatusRows.value, action);
};
const onShowServiceStatus = async (index: number) => {
    const currModule = state.funModule.find((item) => item.loading);
    if (currModule) {
        ElMessage.info(`正在[${currModule.title}]中，请稍等！`);
        return;
    }
    state.funModule[index].loading = true;
    // 复位停止标记（清除上次停止残留的后端取消标记），避免查询被立即中止
    stepPublishApi.resetStopState();
    serviceStatusLoading.value = true;
    serviceStatusVisible.value = true;
    serviceStatusRows.value = [];
    try {
        await loadPublishSettings();
        const result = await stepPublishApi.getServiceStatuses();
        if (result.code !== 0) {
            ElMessage.warning(result.msg);
        }
        serviceStatusRows.value = result.data || [];
    } finally {
        serviceStatusLoading.value = false;
        state.funModule[index].loading = false;
    }
};

// 查看程序集信息（服务端程序集 / 本机程序集共用对话框）
const stagingVisible = ref(false);
const stagingLoading = ref(false);
const stagingRows = ref<StagingAssemblyRow[]>([]);
const stagingErrorMsg = ref("");
const stagingTitle = ref("服务端程序集");
const onShowAssemblyInfo = async (index: number, source: "server" | "local") => {
    const currModule = state.funModule.find((item) => item.loading);
    if (currModule) {
        ElMessage.info(`正在[${currModule.title}]中，请稍等！`);
        return;
    }
    state.funModule[index].loading = true;
    // 复位停止标记（清除上次停止残留的后端取消标记），避免查询被立即中止
    stepPublishApi.resetStopState();
    stagingLoading.value = true;
    stagingTitle.value = source === "local" ? "本机程序集" : "服务端程序集";
    stagingVisible.value = true;
    stagingRows.value = [];
    stagingErrorMsg.value = "";
    try {
        await loadPublishSettings();
        projectAssemblyOutPath.value = await getProjectOutPath();
        const result =
            source === "local"
                ? await stepPublishApi.getLocalAssemblies()
                : await stepPublishApi.getStagingAssemblies();
        if (result.code !== 0) {
            stagingErrorMsg.value = result.msg;
        }
        stagingRows.value = result.data || [];
    } finally {
        stagingLoading.value = false;
        state.funModule[index].loading = false;
    }
};

// 核对程序集（以本机为准，逐文件比对各服务器暂存程序集修改时间）
const checkVisible = ref(false);
const checkLoading = ref(false);
const checkRows = ref<AssemblyDiffRow[]>([]);
const checkErrorMsg = ref("");
const checkOnlyDiff = ref(true);
// 仅看差异：过滤掉一致的行（差异合计含缺失/时间不一致/服务器多出）
const checkDisplayRows = computed(() =>
    checkOnlyDiff.value ? checkRows.value.filter((row) => !row.consistent) : checkRows.value
);
const checkDiffText = (type: string) =>
    type === "missing" ? "缺失" : type === "timeDiff" ? "时间不一致" : "服务器多出";
const checkDiffTagType = (type: string) =>
    type === "timeDiff" ? "warning" : "danger";
const onShowAssemblyCheck = async (index: number) => {
    const currModule = state.funModule.find((item) => item.loading);
    if (currModule) {
        ElMessage.info(`正在[${currModule.title}]中，请稍等！`);
        return;
    }
    state.funModule[index].loading = true;
    // 复位停止标记（清除上次停止残留的后端取消标记），避免查询被立即中止
    stepPublishApi.resetStopState();
    checkLoading.value = true;
    checkVisible.value = true;
    checkRows.value = [];
    checkErrorMsg.value = "";
    checkOnlyDiff.value = true;
    try {
        await loadPublishSettings();
        projectAssemblyOutPath.value = await getProjectOutPath();
        const result = await stepPublishApi.checkAssemblies();
        if (result.msg) {
            checkErrorMsg.value = result.msg;
        }
        checkRows.value = result.data || [];
    } finally {
        checkLoading.value = false;
        state.funModule[index].loading = false;
    }
};

// 备份管理（每个服务器备份目录按名称降序前 10 个备份文件夹及其一级目录明细）
const backupVisible = ref(false);
const backupLoading = ref(false);
const backupRows = ref<ServiceBackupRow[]>([]);
const backupErrorMsg = ref("");
const backupDeleting = ref(false);
const onDeleteServiceBackup = async (row: ServiceBackupRow) => {
    try {
        await ElMessageBox.confirm(
            `确认删除服务器[${row.serverName}]上的备份文件夹？\n${row.backupPath}\n\n该文件夹及其全部内容将被删除，且不可恢复！`,
            "删除备份确认",
            { type: "warning", confirmButtonText: "删 除", cancelButtonText: "取 消", customStyle: { whiteSpace: "pre-line" } as any }
        );
    } catch {
        return; // 用户取消
    }
    backupDeleting.value = true;
    // 复位停止标记（清除上次停止残留的后端取消标记），并支持本次操作中请求停止
    stepPublishApi.resetStopState();
    try {
        const result = await stepPublishApi.deleteServiceBackup(row);
        if (result.code !== 0) {
            ElMessage.error(result.msg);
            return;
        }
        ElMessage.success(result.msg);
        // 删除成功后刷新备份列表
        const refreshResult = await stepPublishApi.getServiceBackups();
        backupRows.value = refreshResult.data || [];
        backupErrorMsg.value = refreshResult.code !== 0 ? refreshResult.msg : "";
    } finally {
        backupDeleting.value = false;
    }
};
// 恢复服务备份
const restoreVisible = ref(false);
const backupRestoring = ref(false);
const restoreServerId = ref(0);
const restoreServerName = ref("");
const restoreFolders = ref<{ name: string; dateFolder: string; path: string; time: string }[]>([]);
const restoreServices = ref<{ module: string; path: string; identity: string }[]>([]);
const onRestoreServiceBackup = (row: ServiceBackupRow) => {
    restoreServerId.value = row.serverId;
    restoreServerName.value = row.serverName;
    // 备份文件夹下拉：仅当前行对应日期备份文件夹下的服务文件夹
    restoreFolders.value = row.services.map((serviceName) => ({
        name: serviceName,
        dateFolder: row.backupDate,
        path: `${row.backupPath}/${serviceName}`,
        time: row.backupTime,
    }));
    // 恢复服务下拉：该服务器的所有服务实例
    restoreServices.value = stepPublishApi.getServiceInstancesByServer(row.serverId).map((ins) => ({
        module: ins.module,
        path: ins.path,
        identity: ins.identity,
    }));
    if (restoreFolders.value.length < 1) {
        ElMessage.warning("备份文件夹中没有服务文件夹，无法恢复.");
        return;
    }
    if (restoreServices.value.length < 1) {
        ElMessage.warning("该服务器没有可恢复的服务实例，请检查应用配置.");
        return;
    }
    restoreVisible.value = true;
};
const onRestoreBackup = async (payload: {
    backupPath: string;
    backupLabel: string;
    module: string;
    servicePath: string;
    identity: string;
}) => {
    backupRestoring.value = true;
    // 复位停止标记（清除上次停止残留的后端取消标记），并支持本次恢复中请求停止
    stepPublishApi.resetStopState();
    try {
        const result = await stepPublishApi.restoreServiceBackup({
            serverId: restoreServerId.value,
            backupFolderName: payload.backupLabel,
            backupPath: payload.backupPath,
            module: payload.module,
            servicePath: payload.servicePath,
            identity: payload.identity,
        });
        if (result.code !== 0) {
            ElMessage.error(result.msg);
            return;
        }
        ElMessage.success(result.msg);
        restoreVisible.value = false;
    } finally {
        backupRestoring.value = false;
    }
};

const onShowServiceBackups = async (index: number) => {
    const currModule = state.funModule.find((item) => item.loading);
    if (currModule) {
        ElMessage.info(`正在[${currModule.title}]中，请稍等！`);
        return;
    }
    state.funModule[index].loading = true;
    // 复位停止标记（清除上次停止残留的后端取消标记），避免查询被立即中止
    stepPublishApi.resetStopState();
    backupLoading.value = true;
    backupVisible.value = true;
    backupRows.value = [];
    backupErrorMsg.value = "";
    try {
        await loadPublishSettings();
        const result = await stepPublishApi.getServiceBackups();
        if (result.code !== 0) {
            backupErrorMsg.value = result.msg;
        }
        backupRows.value = result.data || [];
    } finally {
        backupLoading.value = false;
        state.funModule[index].loading = false;
    }
};

// ==================== 对话框操作停止控制 ====================
// 对话框操作（查看/服务操作/备份删除恢复）是否有进行中的服务器交互
const isDialogOperating = computed(
    () =>
        serviceStatusLoading.value ||
        serviceStatusOperating.value ||
        stagingLoading.value ||
        backupLoading.value ||
        backupDeleting.value ||
        backupRestoring.value
);
// 服务备份对话框内的操作是否进行中
const isBackupOperating = computed(
    () => backupLoading.value || backupDeleting.value || backupRestoring.value
);
// 停止当前对话框操作（查询/服务操作/恢复等，与主停止按钮同一停止通道）
const onStopDialogOp = () => {
    stepPublishApi.requestStop();
    ElMessage.info("已发出停止请求，正在立即停止.");
};

// 打开程序集输出路径
const onOpenAssemblyOutPath = async (openPath: string) => {
    if (!openPath) return;
    await cmdInvoke("open_dir", { path: openPath });
};

// 打开客户端生成路径
const onOpenClientPath = async (openPath: string) => {
    if (!openPath) return;
    await cmdInvoke("open_dir", { path: openPath });
};

// 修改应用配置
const onOpenAppConfig = async () => {
    if (!state.publishData.appconfigData.id) return;
    const appConfigResult = await appconfigDb.getAppconfigById(
        state.publishData.appconfigData.id
    );
    if (appConfigResult.code !== 0) return;
    appconfigDialogRef.value.openDialog("edit", appConfigResult.data.data);
};

// 显示生成目录
const showGenerateDir = (jsonValue: string) => {
    if (!jsonValue) return null;
    let generateDirArr = JSON.parse(jsonValue);
    return generateDirArr.join("、");
};

// 显示打包(压缩)文件
const showCompressFile = (jsonValue: string) => {
    if (!jsonValue) return null;
    let compressFileArr = JSON.parse(jsonValue);
    return compressFileArr.join("、");
};

// 显示dll获取方式
const showDllMode = () => {
    let modelName = state.publishData.appconfigData.dllMode;
    if (modelName == "日期范围") {
        let dllModeArr = JSON.parse(String(state.publishData.appconfigData.dllModeValue));
        modelName += `：${dllModeArr[0]} ~ ${dllModeArr[1]}`;
    } else if (modelName == "DLL名称") {
        const lines = String(state.publishData.appconfigData.dllModeValue || "").split(/\n|、/);
        const firstLine = lines[0]?.trim() || "";
        const more = lines.length > 1 ? ` 等${lines.length}个` : "";
        modelName += `：${firstLine}${more}`;
    } else if (modelName == "TFS" || modelName == "Git") {
        try {
            const selectItem = JSON.parse(String(state.publishData.appconfigData.dllModeValue || "{}"));
            const sourceName = modelName == "TFS" ? selectItem.tfsName : selectItem.gitName;
            const selectModel = String(selectItem.selectModel || "");
            if (sourceName) modelName += `：${sourceName}`;
            if (selectModel === "最近时间") {
                modelName += `；最近时间：最近 ${selectItem.selectValue?.[0]?.value || "-"} 天`;
            } else if (selectModel) {
                modelName += `；${selectModel}`;
            }
        } catch (error) {
            // 兼容脏数据：解析失败时只显示获取方式
        }
    }
    return modelName;
};

// 获取项目输出路径
const getProjectOutPath = async () => {
    let projectOutPath = "";
    let assemblyOutPath = projectList.value?.find(
        (item) => item.id === state.publishData.projectId
    )?.assemblyOutPath;
    if (assemblyOutPath) {
        projectOutPath = assemblyOutPath;
    } else {
        projectOutPath = `${await path.appLocalDataDir()}`;
    }
    return `${removeSlash(projectOutPath)}/${state.publishData.projectName
        }/${displayEnvironment(state.publishData.environment)}`;
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

// 获取默认项目并恢复环境（优先恢复 localStorage 中保存的发布项目，项目已删除则回退默认项目）
const getProjectDefault = async (options?: { keepCurrentEnvironment?: boolean }) => {
    await getProjectList();
    // 1. 优先恢复上次选择的发布项目（需在项目列表中仍存在）
    const savedProjectId = restoreProjectIdFromStorage();
    let projectObj = savedProjectId ? projectList.value?.find((item) => item.id === savedProjectId) : undefined;
    // 2. 未保存过或项目已删除 → 回退默认项目
    if (!projectObj) {
        const dataResult = await projectDb.getProjectDefault();
        if (dataResult.code == 0 && dataResult.data.data?.id) {
            projectObj = dataResult.data.data;
        }
    }
    if (projectObj) {
        const projectId = Number(projectObj.id);
        state.publishData.projectId = projectId;
        saveProjectIdToStorage(projectId);
        state.publishData.projectName = String(projectObj.name);
        state.publishData.assemblyOutPath = projectObj.assemblyOutPath
            ? String(projectObj.assemblyOutPath)
            : "";

        // 查询该项目有哪些环境有配置
        const availableEnvironments: number[] = [];
        for (let env = 1; env <= 4; env++) {
            const result = await appconfigDb.getPublishAppconfigs(projectId, env);
            if (result.code === 0 && result.data.data && result.data.data.id) {
                availableEnvironments.push(env);
            }
        }

        let targetEnvironment = 1;
        const currentEnvironment = state.publishData.environment;
        if (options?.keepCurrentEnvironment && availableEnvironments.includes(currentEnvironment)) {
            targetEnvironment = currentEnvironment;
        } else {
            const savedEnvironment = restoreEnvironmentFromStorage(projectId);
            if (savedEnvironment && availableEnvironments.includes(savedEnvironment)) {
                targetEnvironment = savedEnvironment;
            } else if (availableEnvironments.length > 0) {
                availableEnvironments.sort((a, b) => a - b);
                targetEnvironment = availableEnvironments[0];
            }
        }
        state.publishData.environment = targetEnvironment;
    }
    await getPublishAppconfigs();
};

// 获取发布的应用程序配置
const getPublishAppconfigs = async () => {
    let dataResult = await appconfigDb.getPublishAppconfigs(
        state.publishData.projectId,
        state.publishData.environment
    );
    showEmptyAppConfig.value = true;
    if (dataResult.code == 0 && dataResult.data.data && dataResult.data.data.id) {
        state.publishData.appconfigData = dataResult.data.data;
        showEmptyAppConfig.value = false;
    } else {
        state.publishData.appconfigData = getDefaultSubObject(
            state.publishData.appconfigData
        ) as RowAppconfigType;
    }
};

// 从本地存储恢复环境选择
const restoreEnvironmentFromStorage = (projectId: number): number | null => {
    try {
        const storageKey = `project_environment_${projectId}`;
        const savedEnv = localStorage.getItem(storageKey);
        return savedEnv ? Number(savedEnv) : null;
    } catch (error) {
        console.error("恢复环境选择失败:", error);
        return null;
    }
};

// 保存当前发布项目 id 到本地存储（打开页面时按 id 恢复上次选择）
const saveProjectIdToStorage = (projectId: number) => {
    try {
        localStorage.setItem("publish_step_project_id", String(projectId));
    } catch (error) {
        console.error("保存发布项目id失败:", error);
    }
};

// 从本地存储恢复发布项目 id
const restoreProjectIdFromStorage = (): number | null => {
    try {
        const savedId = localStorage.getItem("publish_step_project_id");
        return savedId ? Number(savedId) : null;
    } catch (error) {
        console.error("恢复发布项目id失败:", error);
        return null;
    }
};

// 最新时间阈值（分钟）：获取/上传程序集前检查本机程序集目录是否有该时间内的新产物，默认 10
const RECENT_MINUTES_KEY = "publish_step_recent_minutes";
const recentMinutes = ref(10);
try {
    const savedMinutes = Number(localStorage.getItem(RECENT_MINUTES_KEY));
    if (savedMinutes >= 1) recentMinutes.value = Math.floor(savedMinutes);
} catch (error) {
    console.error("恢复最新时间阈值失败:", error);
}
const saveRecentMinutesToStorage = () => {
    try {
        localStorage.setItem(RECENT_MINUTES_KEY, String(recentMinutes.value));
    } catch (error) {
        console.error("保存最新时间阈值失败:", error);
    }
};

// 项目切换
const onProjectChange = async (val: number) => {
    saveProjectIdToStorage(val);
    let projectObj = projectList.value?.find((item) => item.id === val);
    if (projectObj) {
        state.publishData.projectName = String(projectObj.name);
        state.publishData.assemblyOutPath = projectObj.assemblyOutPath
            ? String(projectObj.assemblyOutPath)
            : "";

        let availableEnvironments: number[] = [];
        for (let env = 1; env <= 4; env++) {
            const result = await appconfigDb.getPublishAppconfigs(val, env);
            if (result.code === 0 && result.data.data && result.data.data.id) {
                availableEnvironments.push(env);
            }
        }

        const savedEnvironment = restoreEnvironmentFromStorage(val);
        if (savedEnvironment && availableEnvironments.includes(savedEnvironment)) {
            state.publishData.environment = savedEnvironment;
        } else if (availableEnvironments.length > 0) {
            availableEnvironments.sort((a, b) => a - b);
            state.publishData.environment = availableEnvironments[0];
        } else {
            state.publishData.environment = 1;
        }
    }
    await getPublishAppconfigs();
};

// 页面加载完时
onBeforeMount(async () => {
    await getProjectDefault();
});

// keep-alive 重新激活页签：保持缓存状态，不重新查询刷新数据
// （数据恢复仅在 onBeforeMount 首次挂载时执行；需要刷新可点「重置」按钮）
</script>

<style scoped lang="scss">
// 日志控制台为终端风格：底色与文字固定为一套自洽的配色，不跟随主题变量。
// （theme/app.scss 的 .log-info 用 --el-bg-color，深色模式下会变成「深底 + 深字」看不清）
$log-console-bg: #545c64;
$log-console-text: #ffffff;

// 卡片公共外观：顶部功能按钮卡与发布/日志信息卡共用一套（占位符，仅在本文件内 extend）
%card-panel {
    width: 100%;
    border-radius: 0.25rem;
    transition: all ease 0.3s;
    overflow: hidden;
    position: relative;
    background: var(--el-color-white);
    color: var(--el-text-color-primary);
    border: 1px solid var(--el-border-color);
}

// 卡头：发布信息 / 日志信息共用（标题 + 右侧按钮行）
%card-title {
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: 0.6rem;
    border-bottom: 1px var(--el-border-color) solid;
    font-weight: 500;

    .item-btn-box {
        flex: 1;
        text-align: right;
        font-weight: normal;
    }
}

.publish-container {
    display: flex;
    flex-direction: column;
    overflow: hidden;

    // 顶部功能按钮区：flex 换行，按内容高度占位、不参与高度伸缩，换行后下方内容区随之收缩并在内部滚动
    .publish-card-box {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-bottom: 0.5rem;

        // 功能按钮卡：图标 + 标题水平居中
        .menu-item {
            @extend %card-panel;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.625rem;
            padding: 0.2rem 1rem;
            cursor: pointer;

            // hover 效果：上浮 + 边框高亮 + 阴影
            &.fun-hover {
                &:hover {
                    transform: translateY(-0.1875rem);
                    border-color: var(--el-color-primary-light-5);
                    box-shadow: var(--el-box-shadow-light);
                    color: var(--el-color-primary);
                }

                &:active {
                    transform: translateY(-0.0625rem);
                    box-shadow: var(--el-box-shadow-lighter);
                }
            }

            .menu-item-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 2.875rem;
                height: 2.875rem;
                border-radius: 0.25rem;
                flex-shrink: 0;
            }

            :deep(.el-loading-spinner) {
                top: 50%;
                margin-top: 0;
                transform: translateY(-50%);

                svg {
                    width: 1.125rem;
                    height: 1.125rem;
                }

                .el-loading-text {
                    font-size: 0.75rem;
                    margin: 0.125rem 0 0 0;
                }
            }
        }

        // 更多功能下拉菜单：触发卡片与其它功能卡片对齐
        .more-dropdown {
            .publish-card-item {
                outline: none;
            }

            // 下拉箭头：hover 卡片时高亮
            .more-dropdown-arrow {
                color: var(--el-text-color-secondary);
                transition: transform 0.2s;

                &:hover {
                    color: var(--el-color-primary);
                }
            }
        }
    }

    // 配置区：双列 grid（发布信息 | 日志信息），窄屏退化为单列；
    // grid 单元格高度天然等于行高，卡片 height:100% 可直接解析，无需再钉列高
    .publish-card-config {
        flex: 1;
        display: flex;
        flex-direction: row;
        overflow: hidden;
        width: 100%;

        .publish-card-item {
            @extend %card-panel;
            height: 100%;
            border: 1px solid var(--el-border-color);

            .card-item-box {
                height: 100%;
                display: flex;
                flex-direction: column;
            }

            .card-item-content {
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                padding: 0.625rem;

                .card-item-appconfig {
                    width: 100%;
                    margin-top: 0.9375rem;

                    .table-appconfig {
                        width: 100%;
                        border: 1px solid var(--el-color-info);

                        .table-head-row {
                            td {
                                color: var(--el-color-success) !important;
                                font-weight: 500;
                            }

                            .server-type-row {
                                display: flex;
                                flex-direction: row;
                                align-items: center;

                                :first-child {
                                    flex: 1;
                                }
                            }

                            // 表头带问号说明
                            .th-with-tip {
                                display: inline-flex;
                                flex-direction: row;
                                align-items: center;
                                gap: 0.25rem;

                                .th-tip-icon {
                                    cursor: help;
                                    color: var(--el-color-info);
                                }
                            }

                            // 最新时间阈值行：数字输入 + 单位标签
                            .recent-minutes-row {
                                display: flex;
                                flex-direction: row;
                                align-items: center;
                                gap: 0.375rem;

                                label {
                                    color: var(--el-text-color-primary);
                                }
                            }
                        }

                        tr {
                            th {
                                background-color: var(--el-fill-color-lighter);
                                font-weight: 500;
                                text-align: right;
                                width: 8rem;
                                padding: 0.625rem 0.3125rem;
                                border: 1px solid var(--el-border-color-lighter);
                            }

                            td {
                                text-align: left;
                                padding: 0 0.3125rem;
                                border: 1px solid var(--el-border-color-lighter);
                                word-wrap: break-word;
                                word-break: break-all;
                            }
                        }
                    }

                    .table-appconfig:hover {
                        box-shadow: 0.3125rem 0.3125rem 0.9375rem var(--next-color-dark-hover);
                    }

                    .table-appconfig-shadow-none {
                        box-shadow: none !important;
                    }
                }
            }

            // 日志区自身不滚动（覆盖 .card-item-content 的 overflow-y，声明在后生效），日志超出由内部 .log-tab-pane-content 滚动
            .log-content {
                padding: 0;
                text-align: left;
                overflow: hidden;
                display: flex;
                flex-direction: column;

                .log-tabs {
                    flex: 1 1 auto;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;

                    // 只有一个页签时隐藏页签栏
                    &.log-tabs-single :deep(.el-tabs__header) {
                        display: none;
                    }

                    :deep(.el-tabs__content) {
                        flex: 1;
                        overflow: hidden;
                        padding: 0;
                    }

                    :deep(.el-tab-pane) {
                        height: 100%;
                    }
                }

                .log-tab-pane-content {
                    box-sizing: border-box;
                    height: 100%;
                    overflow-y: auto;
                    background-color: $log-console-bg;
                    color: $log-console-text;
                    padding: 0.5rem 1em 0.5rem 0.5rem;
                    text-align: left;

                    // 日志行配色固定（终端风格），覆盖 theme/app.scss 中跟随主题的 .log-* 定义
                    .log-info {
                        color: $log-console-text;
                    }

                    .log-warning {
                        color: var(--el-color-warning);
                    }

                    .log-error {
                        color: var(--el-color-danger);
                    }

                    .log-success {
                        color: var(--el-color-success);
                    }
                }
            }
        }

        .project-card {
            display: flex;
            flex-direction: column;
            background-color: var(--el-fill-color);
            gap: 0.5rem;
            padding: 1rem;
            font-weight: 600;

            .project-select-row {
                display: flex;
                align-items: center;
                gap: 0.2rem;

                .project-select-label {
                    flex: 0 0 6rem;
                    text-align: right;
                }
            }
        }
    }

    // 卡头（发布信息 / 日志信息）
    .card-title {
        @extend %card-title;
    }

    // 配置表单元格工具类
    .t-align-c {
        text-align: center !important;
    }

    .t-border-none {
        border: 0px solid transparent !important;
    }

    // 链接：默认正文色，hover 下划线（实际都在配置表 td 内使用，保留单一来源避免两处规则打架）
    .t-link-path {
        // text-decoration: none;
        color: var(--el-text-color-primary);

        &:hover {
            // text-decoration: underline;
            color: var(--el-color-primary);
            background-color: var(--el-bg-color);
            cursor: pointer;
        }
    }
}

// 下拉菜单挂在 body（teleport），需用全局样式
:global(.more-dropdown-menu .el-dropdown-menu__item) {
    // 图标与文字放大到与顶部功能按钮一致后，适当放宽纵向内边距
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
}

:global(.menu-item) {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    white-space: nowrap;
    font-size: 1.3rem;
}

// el-table 单元格：超出宽度时换行显示（待发布程序集 / 服务状态共用）
.staging-table,
.status-table {
    :deep(.cell) {
        white-space: normal;
        word-break: break-all;
        line-height: 1.25rem;
    }
}

// 核对程序集：工具栏与差异明细
.check-toolbar {
    display: flex;
    align-items: center;
    margin-bottom: 0.625rem;

    .check-summary {
        margin-left: 0.9375rem;
        font-size: 0.8125rem;
        color: var(--el-text-color-secondary);
    }
}

.check-detail {
    padding: 0.3125rem 1.25rem;

    .check-detail-item {
        display: flex;
        align-items: center;
        padding: 0.1875rem 0;

        .check-detail-file {
            margin-left: 0.625rem;
            font-size: 0.8125rem;
            word-break: break-all;
        }

        .check-detail-time {
            margin-left: auto;
            padding-left: 1.25rem;
            font-size: 0.75rem;
            color: var(--el-text-color-secondary);
            white-space: nowrap;
        }
    }
}

.check-detail-empty {
    padding: 0.3125rem 1.25rem;
    font-size: 0.8125rem;
    color: var(--el-text-color-secondary);
}

// 服务状态对话框：批量操作栏
.status-batch-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 0.625rem;

    .status-batch-tip {
        margin-left: 0.625rem;
        font-size: 0.75rem;
        color: var(--el-text-color-secondary);
    }
}
</style>