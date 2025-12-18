/**
 * Droid 响应重写逻辑
 *
 * 将上游的 "Upstream request failed" 错误重写为 "context_length_exceeded"
 * 以便 Droid 可以自动 compact 并重试
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
  source?: "json" | "sse";
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
 * @returns 重写结果，包含是否进行了重写
 */
export function rewriteResponse(params: {
  meta: ResponseMeta;
  body: Buffer;
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

  if (!isUpstreamRequestFailedError(parsed)) {
    return { ...params, rewritten: false };
  }

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
