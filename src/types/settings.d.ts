/** 全局设置行类型（t_settings，id 恒 = 1） */
declare interface RowSettingsType {
	id: number;
	oneClickPublishEnabled: number;       // 0 关 / 1 开
	winServiceRetryCount: number;
	winServiceRetryInterval: number;  // 秒
	winCopyRetryCount: number;
	winCopyRetryInterval: number;         // 秒
	uploadRetryCount: number;             // 项目发布上传文件到服务器的重试次数
	uploadRetryInterval: number;          // 秒
	winServiceStartTimeout: number;       // 服务启动等待超时（秒），sc start 后轮询确认状态的最长等待
	winServiceStopTimeout: number;        // 服务停止等待超时（秒），sc stop 后轮询确认状态的最长等待
	publishModuleOrder: string;           // 发布模块顺序，逗号分隔（项目发布(STEP) 备份/上传/发布共用）
	sshMcpUrl: string;                    // SSH MCP 管理服务 API 地址
	sshMcpAutoSync: number;               // 0 关 / 1 开，启动时自动下行同步
	startupMenu: string;                  // 启动默认菜单：'workstation' 发布工作台 / 'home' 项目发布 / 'publishStep' 项目发布(STEP)
	updateTime?: string;
}
