import type { HooksConfig } from "./proxy";

/** 转发规则配置（运行时使用） */
export interface ForwardRuleConfig {
  id: string;
  name: string;
  target: string;
  enabled: boolean;
  description?: string | null;
  path?: string | null;
  methods?: string[];
  headers?: Record<string, string> | null;
  hooks?: HooksConfig | null;
  /** 请求超时时间（秒），默认无超时 */
  timeout?: number | null;
  /** 自动排序时是否锁定当前同名组内位置 */
  orderLocked?: boolean;
}

/** 实例运行时配置（不包含port，port不可热更新） */
export interface InstanceRuntimeConfig {
  name: string;
  headers: Record<string, string> | null;
  hooks: HooksConfig | null;
  forwards: ForwardRuleConfig[];
}

/** Worker 消息类型 */
export type WorkerMessage =
  | { type: "pre-init"; argv: string[] }
  | { type: "init"; dataDir: string }
  | { type: "reload"; config: InstanceRuntimeConfig }
  | { type: "get-config" }
  | { type: "ping" }
  | { type: "abort-request"; dbRecordId: number }
  | { type: "shutdown" };

/** Worker 响应类型 */
export type WorkerResponse =
  | { type: "init-result"; success: boolean; error?: string }
  | { type: "reload-result"; success: boolean; error?: string }
  | { type: "config"; config: InstanceRuntimeConfig }
  | { type: "pong" }
  | { type: "abort-result"; success: boolean; dbRecordId: number }
  | {
      type: "server-error";
      error: string;
      code?: string;
      stack?: string;
      port?: number;
    }
  | { type: "log"; level: string; message: string; timestamp: number; instanceName: string };
