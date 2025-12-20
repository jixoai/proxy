/**
 * Anthropic 缓存保活插件类型定义
 */

export type CacheControl = { type: "ephemeral" };

export type TextBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
};

/** 通用内容块（可能包含 cache_control） */
export type ContentBlock = {
  type: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
};

export type MessageRole = "user" | "assistant";

export type Message = {
  role: MessageRole;
  content?: string | ContentBlock[];
};

export type AnthropicRequestBody = {
  model?: string;
  system?: string | ContentBlock[];
  messages?: Message[];
  max_tokens?: number;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** 固定的结束保活消息 */
export const PING_SESSION_END_MESSAGE = "jixo:proxy_ping_end";

export interface SessionState {
  sessionId: string;
  /** 会话创建时间 */
  createdAt: number;
  lastActiveTime: number;
  pingCount: number;
  latestContextPayload: AnthropicRequestBody;
  /** Proxy URL（用于发送 ping 请求，走完整的 proxy 流程） */
  proxyUrl: string;
  /** Target URL（仅用于回退，当 proxyUrl 不可用时） */
  targetUrl: string;
  headers: Record<string, string>;
}

export interface PingPluginOptions {
  /** 最大保活时长 ms（默认 60 分钟） */
  maxKeepAliveDurationMs?: number;
  /** 空闲多久后开始保活 ms（默认 4 分钟 = cacheTtl - pingLeadTime） */
  idleThresholdMs?: number;
  pollingIntervalMs?: number;
  debug?: boolean;
  onPing?: (sessionId: string, pingCount: number) => void;
  onExpire?: (sessionId: string, reason: "timeout" | "manual") => void;
}

export interface PingResult {
  success: boolean;
  sessionId: string;
  pingCount: number;
  error?: string;
}
