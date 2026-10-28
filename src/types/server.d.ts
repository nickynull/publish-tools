// serverTableParam
declare type GetServerTableParams = {
	skipCount: number;
	maxResultCount: number;
	projectId: number | null;
	name: string | null;
	sorting: string | null;
}

declare type SelectServerType = {
	id: number | null;
	name: string | null;
	serverPathArr: ServerOptionType[];
}

// 服务器默认服务路径组（含服务类型，应用配置选择服务器后按类型带出）
declare type ServerDefaultPathType = {
	serviceType: string | null; // WebApiHost / ScheduleServer / WebClient / WpfClient / SpcMonitor，空 = 通用（带出到所有服务）
	identity: string | null;
	path: string | null;
}

// server
declare type RowServerType = {
	id: number | null;
	projectId: number | null;
	projectName: string | null;
	name: string;
	os: number;
	ip: string;
	port: number;
	account: string;
	pwd: string;
	description: string | null;
	serviceBackupPath?: string | null;   // 服务备份路径：存放备份文件的目录
	assemblyStagingPath?: string | null; // 程序集暂存路径：存放将要发布的程序集的目录
	defaultServerPaths?: ServerDefaultPathType[] | null; // 默认服务标识/发布路径组（多组，应用配置按服务类型快速带出）
	sourceKey?: string | null;   // SSH MCP 同步来源键（项目/环境/主机），有值=已纳管
	loading?: boolean | null;
};

interface ServerTableType extends TableType<GetServerTableParams> {
	data: RowServerType[];
}

declare interface ServerState {
	tableData: ServerTableType;
}
