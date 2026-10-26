// 定义类型
declare type GetGitParams = {
  gitName: string | null;
  gitRepository: string | null;
  maxResultCount: number;
  skipCount: number;
  sorting?: string;
}
declare type gitSelectValueType = {
	placeholder: string;
	value: string;
};
declare type SelectGitType = {
	id: number | null;
	gitName: string | null;
	// 应用配置界面选项值为「变更集」；"commit" 为历史遗留写法（查询逻辑统一用 isCommitSelectModel 兼容）
	selectModel: "日期" | "变更集" | "commit" | "最近时间",
	selectValue: gitSelectValueType[];
};
declare type RowGitType = {
  id: number | null;
  gitName: string | null;
  gitRepository: string | null;
  gitPath: string | null;
  branchName: string | null;
  remark: string | null;
}


