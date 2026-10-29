declare type DiscoveryPrefix = {
  id: number | null;
  prefix: string;
  enabled: number; // 0/1
  isDefault: number; // 0/1
};

// 文件夹识别子路径（「识别文件夹」在各服务发布路径下探测的子目录）
declare type FolderDetectRule = {
  id: number | null;
  subPath: string;
  enabled: number; // 0/1
  isDefault: number; // 0/1
};

declare type DiscoveryMount = { Source: string; Destination: string };

declare type DiscoveryItem = {
  serviceName: string;
  displayName: string;
  rawPath: string;
  suggestedPublishPath: string;
  source: 'win32' | 'docker';
  containerId?: string;
  mounts?: DiscoveryMount[];
  image?: string;
};
