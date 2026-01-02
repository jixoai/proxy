/**
 * Token Cache - 缓存 Responses API 返回的 input_tokens
 *
 * 策略：
 * 1. 使用 Responses API 返回的实际 input_tokens，而不是 tiktoken 估算
 * 2. 利用 Responses API 更大的上下文窗口 (272K vs Claude 的 200K)
 * 3. 当 count_tokens 请求到来时，返回缓存值 + 简单估算的增量
 */

import type { ClaudeMessage, ClaudeContentBlock } from "./types";

/** 缓存条目 */
interface CacheEntry {
  /** 上次响应的 input_tokens */
  inputTokens: number;
  /** 上次请求的消息数量 */
  messageCount: number;
  /** 缓存时间 */
  timestamp: number;
}

/** 会话级别的 token 缓存 */
const sessionCache = new Map<string, CacheEntry>();

/** 缓存过期时间 (30 分钟) */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** 默认会话 ID */
const DEFAULT_SESSION = "default";

/**
 * 从元数据中提取会话 ID
 */
export function extractSessionId(metadata?: { user_id?: string }): string {
  if (!metadata?.user_id) return DEFAULT_SESSION;

  // user_id 格式: user_xxx_account__session_<session-id>
  const match = metadata.user_id.match(/session_([a-f0-9-]+)/i);
  return match?.[1] || DEFAULT_SESSION;
}

/**
 * 缓存 input_tokens
 */
export function cacheInputTokens(
  sessionId: string,
  inputTokens: number,
  messageCount: number
): void {
  sessionCache.set(sessionId, {
    inputTokens,
    messageCount,
    timestamp: Date.now(),
  });

  // 清理过期缓存
  cleanupExpiredCache();
}

/**
 * 获取缓存的 input_tokens
 */
export function getCachedInputTokens(sessionId: string): CacheEntry | null {
  const entry = sessionCache.get(sessionId);
  if (!entry) return null;

  // 检查是否过期
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    sessionCache.delete(sessionId);
    return null;
  }

  return entry;
}

/**
 * 清理过期缓存
 */
function cleanupExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of sessionCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      sessionCache.delete(key);
    }
  }
}

/**
 * 简单的字符级别 token 估算
 * 平均每 4 个字符约等于 1 个 token
 * 中文字符每个约等于 2-3 个 token
 */
function estimateTokensFromText(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  for (const char of text) {
    // 中文、日文、韩文字符
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(char)) {
      tokens += 2.5;
    } else {
      tokens += 0.25; // 英文平均 4 字符 = 1 token
    }
  }

  return Math.ceil(tokens);
}

/**
 * 估算 content block 的 token 数量
 */
function estimateBlockTokens(block: ClaudeContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokensFromText(block.text);
    case "image":
      return 1500; // 图片固定估算
    case "tool_use":
      return (
        estimateTokensFromText(block.name) +
        estimateTokensFromText(JSON.stringify(block.input))
      );
    case "tool_result":
      if (typeof block.content === "string") {
        return estimateTokensFromText(block.content);
      }
      return block.content.reduce((sum, b) => sum + estimateBlockTokens(b), 0);
    case "thinking":
      return estimateTokensFromText(block.thinking);
    default:
      return 0;
  }
}

/**
 * 估算消息的 token 数量
 */
function estimateMessageTokens(message: ClaudeMessage): number {
  let tokens = 3; // role token

  if (typeof message.content === "string") {
    tokens += estimateTokensFromText(message.content);
  } else {
    for (const block of message.content) {
      tokens += estimateBlockTokens(block);
    }
  }

  return tokens;
}

/**
 * 估算系统提示的 token 数量
 */
function estimateSystemTokens(
  system: string | { type: "text"; text: string }[] | undefined
): number {
  if (!system) return 0;

  if (typeof system === "string") {
    return estimateTokensFromText(system);
  }

  return system.reduce(
    (sum, block) => sum + estimateTokensFromText(block.text),
    0
  );
}

/**
 * 估算请求的 token 数量
 *
 * 策略：
 * 1. 如果有缓存，使用缓存值 + 新消息的估算
 * 2. 如果没有缓存，使用简单的字符级别估算
 */
export function estimateTokenCount(
  body: {
    model?: string;
    system?: string | { type: "text"; text: string }[];
    messages?: ClaudeMessage[];
    tools?: unknown[];
    metadata?: { user_id?: string };
  },
  options?: { sessionId?: string }
): number {
  const sessionId = options?.sessionId || extractSessionId(body.metadata);
  const cached = getCachedInputTokens(sessionId);
  const currentMessageCount = body.messages?.length || 0;

  if (cached) {
    // 有缓存，计算增量
    const newMessages = currentMessageCount - cached.messageCount;

    if (newMessages <= 0) {
      // 消息数没增加或减少了（可能是新对话），返回缓存值
      return cached.inputTokens;
    }

    // 估算新消息的 token
    const messages = body.messages || [];
    let deltaTokens = 0;
    for (let i = cached.messageCount; i < messages.length; i++) {
      deltaTokens += estimateMessageTokens(messages[i]!);
    }

    return cached.inputTokens + deltaTokens;
  }

  // 没有缓存，完全估算
  let tokens = 0;

  // 系统提示
  tokens += estimateSystemTokens(body.system);

  // 消息
  if (body.messages) {
    for (const message of body.messages) {
      tokens += estimateMessageTokens(message);
    }
  }

  // 工具定义
  if (body.tools && body.tools.length > 0) {
    tokens += estimateTokensFromText(JSON.stringify(body.tools));
  }

  // 开销
  tokens += 20;

  return tokens;
}

/**
 * 创建 count_tokens 响应
 */
export function createCountTokensResponse(inputTokens: number): string {
  return JSON.stringify({
    context_management: null,
    input_tokens: inputTokens,
  });
}

/**
 * 从 Responses API JSON 响应中提取 usage 信息
 */
export function extractUsageFromResponse(response: unknown): {
  inputTokens: number;
  outputTokens: number;
} | null {
  if (!response || typeof response !== "object") return null;

  const resp = response as {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  if (!resp.usage) return null;

  return {
    inputTokens: resp.usage.input_tokens || 0,
    outputTokens: resp.usage.output_tokens || 0,
  };
}

/**
 * 从 Responses API SSE 响应中提取 usage 信息
 *
 * SSE 中的 response.completed 事件包含 usage:
 * event: response.completed
 * data: {"type":"response.completed","response":{...,"usage":{"input_tokens":123,"output_tokens":456}}}
 */
export function extractUsageFromSSE(sseText: string): {
  inputTokens: number;
  outputTokens: number;
} | null {
  // 查找 response.completed 事件
  const completedMatch = sseText.match(
    /event:\s*response\.completed[\s\S]*?data:\s*(\{[\s\S]*?\})\n(?:\n|$)/
  );

  if (!completedMatch?.[1]) return null;

  try {
    const data = JSON.parse(completedMatch[1]);
    const usage = data.response?.usage;

    if (!usage) return null;

    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    };
  } catch {
    return null;
  }
}
