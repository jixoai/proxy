/**
 * Droid 响应重写逻辑
 *
 * 将上游的 "Upstream request failed" 错误重写为 "context_length_exceeded"
 * 以便 Droid 可以自动 compact 并重试
 * 
 * 注意：websearch 响应的解析由 droid-patch 的 websearch-native.ts 处理
 * 本模块只负责错误响应的转换
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
  source?: "json" | "sse" | "server_anomaly" | "gateway_empty";
}

/**
 * 检测是否为上游请求失败错误
 */
export function isUpstreamRequestFailedError(parsed: unknown): parsed is {
  type: "error";
  error: { code: number | string; type: string; message: string };
} {
  if (!isRecord(parsed)) return false;
  if (parsed.type === "error") {
    if (!isRecord(parsed.error)) return false;
    const upstreamError = parsed.error;
    const upstreamCode = upstreamError.code;
    if (upstreamCode !== 400 && upstreamCode !== "400") return false;
    if (upstreamError.type !== "server_error") return false;
    if (upstreamError.message !== "Upstream request failed") return false;
    return true;
  }

  if (parsed.type !== "response.failed") return false;
  if (!isRecord(parsed.response)) return false;
  if (!isRecord(parsed.response.error)) return false;

  const upstreamError = parsed.response.error;
  if (upstreamError.code !== "server_error") return false;
  if (upstreamError.message !== "Upstream request failed") return false;
  return true;
}

/**
 * 检测是否为 context_length_exceeded 错误
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
  };
}

function buildJsonMeta(
  meta: ResponseMeta,
  statusCode: number,
  statusMessage: string,
): ResponseMeta {
  return {
    statusCode,
    statusMessage,
    headers: {
      ...(meta.headers ?? {}),
      "content-type": "application/json; charset=utf-8",
    },
  };
}

function shouldTreatAsServerAnomaly(params: {
  requestContentLength?: number;
  serverAnomalyThreshold?: number;
}): boolean {
  if (params.requestContentLength === undefined || params.serverAnomalyThreshold === undefined) {
    return true;
  }
  return params.requestContentLength < params.serverAnomalyThreshold;
}

function isGatewayFailureStatus(statusCode: number | undefined): boolean {
  return statusCode === 502 || statusCode === 503 || statusCode === 504;
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
    if ((eventName !== "error" && eventName !== "response.failed") || dataLines.length === 0) {
      continue;
    }
    const data = dataLines.join("\n");
    const trimmed = data.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    const parsed = safeParseJson(data);
    if (!parsed) continue;
    if (eventName === "error" || eventName === "response.failed") return parsed;
    if (isRecord(parsed) && (parsed.type === "error" || parsed.type === "response.failed")) {
      return parsed;
    }
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
    // 部分上游会返回空 body 的 502/503/504。这里按请求大小区分：
    // - 小请求：视为网关异常，避免误触发 compact
    // - 大请求：视为可 compact 的 context_length_exceeded
    if (isGatewayFailureStatus(params.meta.statusCode)) {
      if (shouldTreatAsServerAnomaly(params)) {
        const anomalyBody = buildServerAnomalyBody();
        return {
          meta: buildJsonMeta(params.meta, 500, "Internal Server Error"),
          body: Buffer.from(JSON.stringify(anomalyBody), "utf-8"),
          rewritten: true,
          source: "gateway_empty",
        };
      }

      const rewrittenBody = buildContextLengthExceededBody();
      return {
        meta: buildJsonMeta(params.meta, 400, "Bad Request"),
        body: Buffer.from(JSON.stringify(rewrittenBody), "utf-8"),
        rewritten: true,
        source: "gateway_empty",
      };
    }

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

  // 检测 "Upstream request failed" 错误
  if (isUpstreamRequestFailedError(parsed)) {
    // 如果请求较小（< 阈值），说明不是真正的 context_length_exceeded，是服务器异常
    if (shouldTreatAsServerAnomaly(params)) {
      const anomalyBody = buildServerAnomalyBody();
      return {
        meta: buildJsonMeta(params.meta, 500, "Internal Server Error"),
        body: Buffer.from(JSON.stringify(anomalyBody), "utf-8"),
        rewritten: true,
        source: "server_anomaly",
      };
    }

    // 请求较大，正常转换为 context_length_exceeded
    const rewrittenBody = buildContextLengthExceededBody();
    return {
      meta: buildJsonMeta(params.meta, 400, "Bad Request"),
      body: Buffer.from(JSON.stringify(rewrittenBody), "utf-8"),
      rewritten: true,
      source: directParsed ? "json" : "sse",
    };
  }

  // 检测 200 状态码直接返回 context_length_exceeded 的情况
  if (params.meta.statusCode === 200 && isContextLengthExceededError(parsed)) {
    if (shouldTreatAsServerAnomaly(params)) {
      const anomalyBody = buildServerAnomalyBody();
      return {
        meta: buildJsonMeta(params.meta, 500, "Internal Server Error"),
        body: Buffer.from(JSON.stringify(anomalyBody), "utf-8"),
        rewritten: true,
        source: "server_anomaly",
      };
    }

    const rewrittenBody = buildContextLengthExceededBody();
    return {
      meta: buildJsonMeta(params.meta, 400, "Bad Request"),
      body: Buffer.from(JSON.stringify(rewrittenBody), "utf-8"),
      rewritten: true,
      source: directParsed ? "json" : "sse",
    };
  }

  return { ...params, rewritten: false };
}
