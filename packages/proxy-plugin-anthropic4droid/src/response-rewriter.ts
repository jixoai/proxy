/**
 * Droid 响应重写逻辑
 *
 * 1. 将上游的 "Upstream request failed" 错误重写为 "context_length_exceeded"
 *    以便 Droid 可以自动 compact 并重试
 * 2. 转换 web_search 响应格式，添加 snippet 字段
 */

import {
  isRecord,
  normalizeHeaders,
  isJsonContentType,
  isEventStreamContentType,
  safeParseJson,
} from "@jixo/proxy-plugin";
import type { ResponseMeta } from "@jixo/proxy-plugin";

export interface ResponseRewriteResult {
  meta: ResponseMeta;
  body: Buffer;
  rewritten: boolean;
  source?: "json" | "sse" | "server_anomaly";
}

/**
 * 检测是否为上游请求失败错误
 */
export function isUpstreamRequestFailedError(parsed: unknown): parsed is {
  type: "error";
  error: { code: number | string; type: string; message: string };
} {
  if (!isRecord(parsed)) return false;
  if (parsed.type !== "error") return false;
  if (!isRecord(parsed.error)) return false;
  const upstreamError = parsed.error;
  const upstreamCode = upstreamError.code;
  if (upstreamCode !== 400 && upstreamCode !== "400") return false;
  if (upstreamError.type !== "server_error") return false;
  if (upstreamError.message !== "Upstream request failed") return false;
  return true;
}

/**
 * 检测是否为 "prompt is too long" 错误
 * Claude 返回的错误消息可能包含：
 * - "prompt is too long"
 * - "request too large"
 * - "maximum context length"
 * - "too many tokens"
 * - "input is too long"
 */
export function isPromptTooLongError(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  if (parsed.type !== "error") return false;
  if (!isRecord(parsed.error)) return false;
  const message = String(parsed.error.message || "").toLowerCase();
  return (
    message.includes("prompt is too long") ||
    message.includes("request too large") ||
    message.includes("maximum context length") ||
    message.includes("too many tokens") ||
    message.includes("input is too long")
  );
}

/**
 * 检测是否为过载/容量不足错误 (429)
 * 包括：
 * - overloaded_error 类型
 * - RESOURCE_EXHAUSTED / MODEL_CAPACITY_EXHAUSTED
 * - "No capacity available" 消息
 */
export function isOverloadedError(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  if (parsed.type !== "error") return false;
  if (!isRecord(parsed.error)) return false;
  
  const errorType = parsed.error.type;
  const message = String(parsed.error.message || "").toLowerCase();
  
  return (
    errorType === "overloaded_error" ||
    message.includes("no capacity available") ||
    message.includes("resource_exhausted") ||
    message.includes("model_capacity_exhausted") ||
    message.includes("overloaded")
  );
}

/**
 * 构建过载错误响应体
 */
export function buildOverloadedErrorBody() {
  return {
    type: "error",
    message: "Service temporarily overloaded",
    error: {
      type: "overloaded_error",
      code: "overloaded",
      message: "Service temporarily overloaded, please retry",
    },
  };
}

/**
 * 检测是否为 context_length_exceeded 错误（200 状态码返回的异常情况）
 */
export function isContextLengthExceededError(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  if (parsed.type !== "error") return false;
  if (!isRecord(parsed.error)) return false;
  const errCode = parsed.error.code;
  return errCode === "context_length_exceeded";
}

/**
 * 构建服务器异常错误响应体
 */
export function buildServerAnomalyBody() {
  return {
    type: "error",
    message: "Server anomaly",
    error: {
      type: "server_error",
      code: "server_anomaly",
      message: "Server anomaly",
    },
  };
}

/**
 * 构建 context_length_exceeded 错误响应体
 */
export function buildContextLengthExceededBody() {
  return {
    type: "error",
    message: "context length exceeded",
    error: {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: "context length exceeded",
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * 判断文本是否看起来像 SSE
 */
export function looksLikeSse(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  return head.startsWith("event:") || head.startsWith("data:") || head.includes("\ndata:");
}

// === Web Search Response Transformation ===

interface WebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  encrypted_content?: string;
  page_age?: string | null;
  snippet?: string;
  page_content?: string;
}

interface WebSearchToolResult {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: WebSearchResult[];
}

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface ClaudeResponse {
  content?: ContentBlock[];
  [key: string]: unknown;
}

/**
 * 检测响应是否包含 web_search_tool_result
 */
export function hasWebSearchToolResult(parsed: unknown): parsed is ClaudeResponse {
  if (!isRecord(parsed)) return false;
  if (!Array.isArray(parsed.content)) return false;
  return parsed.content.some(
    (block: unknown) => isRecord(block) && block.type === "web_search_tool_result"
  );
}

/**
 * 从响应中提取后续 text 块的内容（用作 snippet 的备选来源）
 */
export function extractTextFromResponse(response: ClaudeResponse): string {
  if (!response.content) return "";
  const textBlocks = response.content.filter(
    (block): block is ContentBlock & { text: string } =>
      block.type === "text" && typeof block.text === "string"
  );
  return textBlocks.map((b) => b.text).join("\n\n");
}

/**
 * 转换 web_search 响应，为每个 web_search_result 添加 snippet 字段
 * 
 * Claude 返回的 web_search_result 只有 encrypted_content（加密内容）
 * droid-patch 期望 snippet 或 page_content 字段
 * 
 * 策略：
 * 1. 如果有 page_content，使用它
 * 2. 否则使用 title 作为 snippet（因为 encrypted_content 不可读）
 */
export function transformWebSearchResponse(parsed: ClaudeResponse): ClaudeResponse {
  if (!parsed.content) return parsed;

  const transformed = { ...parsed, content: [...parsed.content] };

  for (let i = 0; i < transformed.content.length; i++) {
    const block = transformed.content[i];
    if (!block) continue;
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      const toolResult = block as unknown as WebSearchToolResult;
      const transformedResults = toolResult.content.map((result) => {
        // 如果已有 snippet 或 page_content，保持不变
        if (result.snippet || result.page_content) {
          return result;
        }
        // 使用 title 作为 snippet（因为 encrypted_content 不可读）
        return {
          ...result,
          snippet: result.title || "",
        };
      });
      transformed.content[i] = {
        ...(block as ContentBlock),
        type: (block as ContentBlock).type,
        content: transformedResults,
      } as ContentBlock;
    }
  }

  return transformed;
}

/**
 * 从 SSE 错误事件中提取 JSON
 */
export function extractJsonFromSseError(text: string): unknown | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const field = line.slice(0, idx).trim();
      let value = line.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      if (field === "data") dataLines.push(value);
    }
    if (eventName !== "error" || dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    const trimmed = data.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    const parsed = safeParseJson(data);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 重写响应
 *
 * @param params.meta - 响应元数据
 * @param params.body - 响应体
 * @param params.requestContentLength - 请求的 content-length（可选，用于检测服务器异常）
 * @param params.serverAnomalyThreshold - 服务器异常检测阈值（字节）
 * @returns 重写结果，包含是否进行了重写
 */
export function rewriteResponse(params: {
  meta: ResponseMeta;
  body: Buffer;
  requestContentLength?: number;
  serverAnomalyThreshold?: number;
}): ResponseRewriteResult {
  const headers = normalizeHeaders(params.meta.headers) ?? {};
  const contentType = headers["content-type"];
  const text = params.body.toString("utf-8");

  if (!text.trim()) {
    return { ...params, rewritten: false };
  }

  // 尝试直接解析 JSON
  const directParsed =
    isJsonContentType(contentType) || text.trimStart().startsWith("{")
      ? safeParseJson(text)
      : null;

  // 尝试从 SSE 中提取
  const sseParsed =
    directParsed
      ? null
      : isEventStreamContentType(contentType) || looksLikeSse(text)
        ? extractJsonFromSseError(text)
        : null;

  const parsed = directParsed ?? sseParsed;

  // 检测过载错误 (429) - 返回 502 Bad Gateway
  if (isOverloadedError(parsed)) {
    const rewrittenBody = buildOverloadedErrorBody();
    const nextMeta: ResponseMeta = {
      statusCode: 502,
      statusMessage: "Bad Gateway",
      headers: {
        ...(params.meta.headers ?? {}),
        "content-type": "application/json; charset=utf-8",
      },
    };
    return {
      meta: nextMeta,
      body: Buffer.from(JSON.stringify(rewrittenBody), "utf-8"),
      rewritten: true,
      source: directParsed ? "json" : "sse",
    };
  }

  // 检测明确的 "prompt is too long" 错误 - 直接返回 context_length_exceeded，不检查请求大小
  if (isPromptTooLongError(parsed)) {
    const rewrittenBody = buildContextLengthExceededBody();
    const nextMeta: ResponseMeta = {
      statusCode: 400,
      statusMessage: "Bad Request",
      headers: {
        ...(params.meta.headers ?? {}),
        "content-type": "application/json; charset=utf-8",
      },
    };
    return {
      meta: nextMeta,
      body: Buffer.from(JSON.stringify(rewrittenBody), "utf-8"),
      rewritten: true,
      source: directParsed ? "json" : "sse",
    };
  }

  // 检测 "Upstream request failed" 错误 - 需要检查请求大小来区分服务器异常
  if (isUpstreamRequestFailedError(parsed)) {
    // 如果请求较小（< 阈值），说明不是真正的 context_length_exceeded，是服务器异常
    if (
      params.requestContentLength !== undefined &&
      params.serverAnomalyThreshold !== undefined &&
      params.requestContentLength < params.serverAnomalyThreshold
    ) {
      const anomalyBody = buildServerAnomalyBody();
      const anomalyMeta: ResponseMeta = {
        statusCode: 500,
        statusMessage: "Internal Server Error",
        headers: {
          ...(params.meta.headers ?? {}),
          "content-type": "application/json; charset=utf-8",
        },
      };
      return {
        meta: anomalyMeta,
        body: Buffer.from(JSON.stringify(anomalyBody), "utf-8"),
        rewritten: true,
        source: "server_anomaly",
      };
    }

    // 请求较大，正常转换为 context_length_exceeded
    const rewrittenBody = buildContextLengthExceededBody();
    const nextMeta: ResponseMeta = {
      statusCode: 400,
      statusMessage: "Bad Request",
      headers: {
        ...(params.meta.headers ?? {}),
        "content-type": "application/json; charset=utf-8",
      },
    };
    return {
      meta: nextMeta,
      body: Buffer.from(JSON.stringify(rewrittenBody), "utf-8"),
      rewritten: true,
      source: directParsed ? "json" : "sse",
    };
  }

  // 检测 200 状态码直接返回 context_length_exceeded 的情况（异常，但需要修正 HTTP status）
  if (params.meta.statusCode === 200 && isContextLengthExceededError(parsed)) {
    // 小请求：视为服务器异常（返回 500）
    if (
      params.requestContentLength !== undefined &&
      params.serverAnomalyThreshold !== undefined &&
      params.requestContentLength < params.serverAnomalyThreshold
    ) {
      const anomalyBody = buildServerAnomalyBody();
      const anomalyMeta: ResponseMeta = {
        statusCode: 500,
        statusMessage: "Internal Server Error",
        headers: {
          ...(params.meta.headers ?? {}),
          "content-type": "application/json; charset=utf-8",
        },
      };
      return {
        meta: anomalyMeta,
        body: Buffer.from(JSON.stringify(anomalyBody), "utf-8"),
        rewritten: true,
        source: "server_anomaly",
      };
    }

    // 非小请求：仍然是 context_length_exceeded，但 200 不合理，修正为 400 并统一 body 格式
    const rewrittenBody = buildContextLengthExceededBody();
    const nextMeta: ResponseMeta = {
      statusCode: 400,
      statusMessage: "Bad Request",
      headers: {
        ...(params.meta.headers ?? {}),
        "content-type": "application/json; charset=utf-8",
      },
    };
    return {
      meta: nextMeta,
      body: Buffer.from(JSON.stringify(rewrittenBody), "utf-8"),
      rewritten: true,
      source: directParsed ? "json" : "sse",
    };
  }

  // 处理 web_search 响应：为 web_search_result 添加 snippet 字段
  // 仅处理非 SSE 的 JSON 响应（stream: false 的请求）
  if (directParsed && hasWebSearchToolResult(directParsed)) {
    const transformed = transformWebSearchResponse(directParsed);
    return {
      meta: params.meta,
      body: Buffer.from(JSON.stringify(transformed), "utf-8"),
      rewritten: true,
      source: "json",
    };
  }

  return { ...params, rewritten: false };
}
