import { db } from '@/database/sqlite';

// 文件夹识别子路径配置（「识别文件夹」在各服务发布路径下探测的子目录）
export function useFolderDetectRuleDb() {
  return {
    getRules: async () => {
      const rows = await (await db()).select<FolderDetectRule[]>(
        "select id, sub_path subPath, enabled, is_default isDefault from t_folder_detect_rule order by is_default desc, sub_path asc"
      );
      return { code: 0, msg: "ok", data: rows } as DataResultType<FolderDetectRule[]>;
    },
    upsertRule: async (row: FolderDetectRule) => {
      if (!row.subPath?.trim()) return { code: 1, msg: "识别路径不能为空", data: 0 } as DataResultType<number>;
      // 存在则 update enabled，否则 insert（sub_path 唯一键，冲突时 update）
      const r = await (await db()).execute(
        "INSERT INTO t_folder_detect_rule (sub_path, enabled, is_default) VALUES ($1,$2,$3) ON CONFLICT(sub_path) DO UPDATE SET enabled=$2",
        [row.subPath.trim(), row.enabled ?? 1, row.isDefault ?? 0]
      );
      return { code: 0, msg: "ok", data: r.rowsAffected } as DataResultType<number>;
    },
    deleteRule: async (id: number) => {
      const rows = await (await db()).select<FolderDetectRule[]>("select is_default isDefault from t_folder_detect_rule where id=$1", [id]);
      if (rows[0]?.isDefault === 1) return { code: 1, msg: "默认识别路径不可删除，可禁用", data: null } as any;
      await (await db()).execute("delete from t_folder_detect_rule where id=$1", [id]);
      return { code: 0, msg: "ok", data: null } as unknown as DataResultType<void>;
    },
    seedDefaults: async () => {
      const defaults = ["logs", "wwwroot/Templates"];
      for (const p of defaults) {
        await (await db()).execute(
          "INSERT OR IGNORE INTO t_folder_detect_rule (sub_path, enabled, is_default) VALUES ($1,1,1)", [p]
        );
      }
    },
  };
}
