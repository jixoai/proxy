export interface ProxyForwardHeaders {
  [key: string]: string;
}

/** http 类型的 hook 配置，通过子进程启动 http 服务并通过 HTTP 调用 */
export interface HttpHookConfig {
  type: "http";
  command: string;
  args?: string[];
  cwd?: string;
}

export type HookConfig = HttpHookConfig;

/** hooks 配置，支持 request 和 response 两个阶段，每个阶段可以是单个 hook 或多个 hooks 数组 */
export interface HooksConfig {
  request?: HookConfig | HookConfig[] | null;
  response?: HookConfig | HookConfig[] | null;
}

export interface ProxyForwardConfig {
  name: string;
  enabled: boolean;
  target: string;
  description: string | null;
  path: string | null;
  methods: string[];
  headers: ProxyForwardHeaders | null;
  hooks?: HooksConfig | null;
}

/** 实例级别设置 */
export interface ProxyInstanceSettings {
  /** 是否启用同名转发规则的智能排序（基于健康度自动调整同名规则顺序） */
  autoSortSameNameForwards?: boolean;
  /** 是否自动推送配置到 worker */
  autoPushConfig?: boolean;
}

export interface ProxyInstanceConfig {
  name: string;
  port: number;
  enabled: boolean;
  description: string | null;
  headers: ProxyForwardHeaders | null;
  hooks?: HooksConfig | null;
  forwards: ProxyForwardConfig[];
  /** 实例级别设置 */
  settings?: ProxyInstanceSettings | null;
}

/** 全局设置 */
export interface ProxyGlobalSettings {
  /** 是否自动监听配置文件变更 */
  autoWatchConfig: boolean;
}

export interface ProxyConfigFile {
  /** 全局设置 */
  settings?: ProxyGlobalSettings;
  instances: ProxyInstanceConfig[];
}


