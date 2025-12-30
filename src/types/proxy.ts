export interface ProxyForwardHeaders {
  [key: string]: string;
}

/** http 类型的 hook 配置，通过子进程启动 http 服务并通过 HTTP 调用 */
export interface HttpHookConfig {
  type: "http";
  /** 是否禁用该 hook（禁用时不执行；且不参与 hookId 计算） */
  disabled?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  /** 插件配置参数，会通过环境变量 PLUGIN_CONFIG 传递给插件进程（JSON 字符串） */
  config?: Record<string, unknown>;
}

export type HookConfig = HttpHookConfig;

/** 插件配置类型别名，用于更清晰地表达意图 */
export type PluginConfig = Record<string, unknown>;

/** hooks 配置：单个插件或插件数组，每个插件同时作为 request 和 response hook */
export type HooksConfig = HookConfig | HookConfig[] | null;

/** 单层 hook 执行结果 */
export interface HookLayer {
  /** 插件名称 */
  pluginName: string;
  /** 是否修改了内容 */
  modified: boolean;
  /** 以下字段仅在 modified=true 时存在 */
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  bodyDataUrl?: string | null;
  bodySize?: number;
  /** Response 特有字段 */
  statusCode?: number;
  statusMessage?: string;
  contentType?: string | null;
}

export interface ProxyForwardConfig {
  /** 唯一标识符，为空时自动生成 UUID */
  id?: string;
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
  /** 前端是否自动拉取配置（收到 config-changed 时自动刷新 UI） */
  frontendAutoPullConfig: boolean;
  /** 数据存储目录路径 (相对于用户主目录或绝对路径) */
  dbPath?: string;
}

export interface ProxyConfigFile {
  /** 全局设置 */
  settings?: ProxyGlobalSettings;
  instances: ProxyInstanceConfig[];
}
