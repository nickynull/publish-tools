import { ref } from 'vue';
import { cmdInvoke } from '@/utils/command';
import { useDiscoveryPrefixDb } from '@/database/discoveryPrefix';

export function useServiceDiscovery() {
  const prefixes = ref<DiscoveryPrefix[]>([]);
  const scanning = ref(false);
  const results = ref<DiscoveryItem[]>([]);
  const error = ref<string | null>(null);

  const loadPrefixes = async () => {
    const db = useDiscoveryPrefixDb();
    await db.seedDefaults();
    const r = await db.getPrefixes();
    prefixes.value = (r.data || []).filter((p) => p.enabled === 1);
  };

  const scanLocal = async () => {
    scanning.value = true;
    error.value = null;
    results.value = [];
    try {
      const ps = prefixes.value.map((p) => p.prefix);
      const r = await cmdInvoke<DiscoveryItem[]>('discover_local_services', { prefixes: ps });
      if (r.code === 0) results.value = r.data || [];
      else error.value = r.msg;
    } catch (e: any) {
      error.value = e.message;
    } finally {
      scanning.value = false;
    }
    return results.value;
  };

  /**
   * 扫描单台远端服务器,返回结果与错误,不写共享状态
   * 供多选多台逐台扫描(每台一份结果)使用
   */
  const scanRemoteOne = async (server: {
    ip: string;
    port?: number;
    account: string;
    pwd: string;
    os?: number; // 服务环境：1=Windows，2=Docker；未传则两者都探测
  }): Promise<{ items: DiscoveryItem[]; error: string | null }> => {
    const ps = prefixes.value.map((p) => p.prefix);
    // 兼容旧调用：未传 port 时沿用调用方传入的字符串（可能已自带端口）
    const target = server.port ? `${server.ip}:${server.port}` : server.ip;
    try {
      // 按服务环境分发：Docker(2) 只探测容器，Windows(1) 只探测 Windows 服务
      const tasks: Promise<DataResultType<DiscoveryItem[]>>[] = [];
      if (server.os !== 2) {
        tasks.push(
          cmdInvoke<DiscoveryItem[]>('discover_remote_windows_services', {
            username: server.account,
            password: server.pwd,
            server: target,
            prefixes: ps,
          })
        );
      }
      if (server.os !== 1) {
        tasks.push(
          cmdInvoke<DiscoveryItem[]>('discover_remote_docker_containers', {
            username: server.account,
            password: server.pwd,
            server: target,
            prefixes: ps,
          })
        );
      }
      const responses = await Promise.all(tasks);
      const items: DiscoveryItem[] = [];
      const failures: string[] = [];
      for (const r of responses) {
        if (r.code === 0 && Array.isArray(r.data)) items.push(...r.data);
        else failures.push(r.msg || "");
      }
      // 仅当全部失败时才视为整体失败（部分失败时保留成功侧结果）
      const err =
        failures.length === responses.length && failures.length > 0
          ? failures.find(Boolean) || '扫描失败'
          : null;
      return { items, error: err };
    } catch (e: any) {
      return { items: [], error: e?.message ?? String(e) };
    }
  };

  const scanRemote = async (server: {
    ip: string;
    port?: number;
    account: string;
    pwd: string;
    os?: number;
  }) => {
    scanning.value = true;
    error.value = null;
    results.value = [];
    try {
      const r = await scanRemoteOne(server);
      results.value = r.items;
      // 零匹配由 UI 引导改前缀,不算错误
      error.value = r.error;
    } finally {
      scanning.value = false;
    }
    return results.value;
  };

  return { prefixes, scanning, results, error, loadPrefixes, scanLocal, scanRemote, scanRemoteOne };
}
