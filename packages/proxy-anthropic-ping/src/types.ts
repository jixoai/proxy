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

/**
 * 跳过 ping 的匹配规则
 *
 * 支持两种匹配类型：
 * 1. JMESPath - 查询请求体，结果为 truthy 则跳过
 * 2. responseStatus - 当 ping 响应状态码匹配时停止该会话的 ping
 *
 * @example
 * // JMESPath: 最后一条 user 消息以指定前缀开头
 * "messages[?role=='user'] | [-1] | starts_with(content, 'jixo:proxy-ping-end')"
 *
 * // JMESPath: 对象格式
 * { jmespath: "messages[?role=='user'] | [0] | starts_with(content, 'A previous')" }
 *
 * // 响应状态码匹配
 * { responseStatus: 400 }
 * { responseStatus: [400, 401, 403] }
 *
 * @see https://jmespath.org/
 */
export type SkipPingMatcher =
  | string // JMESPath 简写
  | { jmespath: string } // JMESPath 明确格式
  | { responseStatus: number | number[] }; // 响应状态码

/**
 * 默认的 skip ping 匹配器
 *
 * 1. 第一条 user 消息以 Droid 会话摘要开头（恢复会话场景）
 * 2. 最后一条 user 消息以 jixo:proxy-ping-end 或 jixo:proxy-stop-ping 开头
 * 3. ping 响应状态码为 400（通常表示请求格式错误，无需继续）
 * 4. 最后一条 user 消息以压缩提示开头（触发压缩场景）
 */
export const DEFAULT_SKIP_PING_MATCHERS: SkipPingMatcher[] = [
  // 1. Droid 恢复会话摘要
  "messages[?role=='user'] | [0] | starts_with(content, 'A previous instance of Droid has summarized the conversation thus far as follows:')",
  // 2. 显式停止 ping 指令
  "messages[?role=='user'] | [-1] | starts_with(content, 'jixo:proxy-ping-end') || starts_with(content, 'jixo:proxy-stop-ping')",
  // 3. 响应 400 错误时停止
  { responseStatus: 400 },
  // 4. Claude Code 压缩摘要提示
  "messages[?role=='user'] | [-1] | starts_with(content, 'Your task is to create a detailed summary of the conversation so far, paying close attention to the user')",
];

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
  /**
   * 跳过 ping 的匹配规则列表
   *
   * 支持两种匹配类型：
   * - JMESPath: 查询请求体，匹配时立即返回 204
   * - responseStatus: ping 响应状态码匹配时停止该会话
   *
   * @default DEFAULT_SKIP_PING_MATCHERS
   * @see https://jmespath.org/
   */
  skipPingMatchers?: SkipPingMatcher[];
  onPing?: (sessionId: string, pingCount: number) => void;
  onExpire?: (sessionId: string, reason: "timeout" | "manual") => void;
}

export interface PingResult {
  success: boolean;
  sessionId: string;
  pingCount: number;
  error?: string;
}
