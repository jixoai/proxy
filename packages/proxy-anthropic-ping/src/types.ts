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

export interface SessionState {
  sessionId: string;
  lastActiveTime: number;
  pingCount: number;
  latestContextPayload: AnthropicRequestBody;
  /** Proxy URL（用于发送 ping 请求，走完整的 proxy 流程） */
  proxyUrl: string;
  /** Target URL（仅用于回退，当 proxyUrl 不可用时） */
  targetUrl: string;
  headers: Record<string, string>;
}

export type CancelTrigger = {
  /** 匹配最后一条 user message 的正则表达式 */
  messagePattern?: RegExp;
  /** 匹配 header 的 key（存在即触发） */
  headerKey?: string;
  /** 自定义判断函数 */
  custom?: (body: AnthropicRequestBody, headers: Record<string, string>) => boolean;
};

export interface PingPluginOptions {
  maxPings?: number;
  /** 空闲多久后开始保活 ms（默认 4 分钟 = cacheTtl - pingLeadTime） */
  idleThresholdMs?: number;
  pollingIntervalMs?: number;
  debug?: boolean;
  /** 取消保活的触发条件，满足任一即取消 */
  cancelTriggers?: CancelTrigger[];
  onPing?: (sessionId: string, pingCount: number) => void;
  onExpire?: (sessionId: string, reason: "max_pings" | "ttl_exceeded") => void;
  onCancel?: (sessionId: string, trigger: string) => void;
}

export interface PingResult {
  success: boolean;
  sessionId: string;
  pingCount: number;
  error?: string;
}
