export interface ProxyForwardHeaders {
  [key: string]: string;
}

/** stdio 类型的 hook 配置，通过子进程 + jsonrpc2 通信 */
export interface StdioHookConfig {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
}

export type HookConfig = StdioHookConfig;

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

export interface ProxyInstanceConfig {
  name: string;
  port: number;
  enabled: boolean;
  description: string | null;
  headers: ProxyForwardHeaders | null;
  hooks?: HooksConfig | null;
  forwards: ProxyForwardConfig[];
}

export interface ProxyConfigFile {
  instances: ProxyInstanceConfig[];
}

export interface ProxyForward {
  id?: number;
  instance_id?: number;
  name: string;
  enabled: boolean;
  target_url: string;
  description: string | null;
  path: string | null;
  method: string;
  custom_headers: string | null;
}

export interface ProxyInstance {
  id?: number;
  name: string;
  port: number;
  enabled: boolean;
  description: string | null;
  instance_headers: string | null;
}
