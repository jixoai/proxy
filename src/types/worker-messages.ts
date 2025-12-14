import type { HooksConfig } from "./proxy";

/** 转发规则配置（运行时使用） */
export interface ForwardRuleConfig {
  name: string;
  target: string;
  enabled: boolean;
  description?: string | null;
  path?: string | null;
  methods?: string[];
  headers?: Record<string, string> | null;
  hooks?: HooksConfig | null;
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
  | { type: "reload"; config: InstanceRuntimeConfig }
  | { type: "get-config" }
  | { type: "ping" }
  | { type: "abort-request"; dbRecordId: number };

/** Worker 响应类型 */
export type WorkerResponse =
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
