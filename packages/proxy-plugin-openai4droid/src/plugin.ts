/**
 * Droid 插件
 *
 * 包含两个功能：
 * 1. Request Hook: 将 Droid-CLI 格式的请求转换为 Codex-CLI 格式
 * 2. Response Hook: 处理错误响应和 web_search 结果
 */

import { z } from "zod";
import type {
  ProxyPlugin,
  RequestHookParams,
  RequestHookResult,
  ResponseHookParams,
  ResponseHookResult,
  RequestMeta,
  ResponseMeta,
  PrecheckResult,
  PluginLogger,
} from "@jixo/proxy-plugin";
import { normalizeHeaders, createLogger, readStreamToBuffer, streamFromBuffer } from "@jixo/proxy-plugin";
import { rewriteRequest, isDroidRequest, isNativeSummarizerRequest } from "./rewriter";
import {
  rewriteResponse,
  buildContextLengthExceededBody,
  buildServerAnomalyBody,
} from "./response-rewriter";

/** 服务器异常检测阈值（字节）
 * 与 anthropic4droid 保持一致，避免 mission 模式下 70KB 级普通请求被误判为 context_length_exceeded。
 */
const DEFAULT_SERVER_ANOMALY_THRESHOLD = 680 * 1024;
const DEFAULT_PREEMPTIVE_CONTEXT_LENGTH_THRESHOLD = 0;
const COMPACTION_SSE_PEEK_LIMIT = 64 * 1024;
const COMPACTION_HEARTBEAT_MS = 15_000;
const COMPACTION_MAX_WAIT_MS = 45_000;
const COMPACTION_MIN_PARTIAL_CHARS = 1_024;

/** 插件存储 schema - 标记请求是否被转换 */
const DroidStoreSchema = z.object({
  /** 请求已被 Droid 插件转换 */
  activated: z.literal(true),
  /** 该次请求体字节长度（用于 response hook 判断是否为服务器异常） */
  requestBodyLength: z.number().int().nonnegative(),
  /** 请求类型 */
  requestKind: z.enum(["standard", "compaction"]).default("standard"),
});

type DroidStore = z.infer<typeof DroidStoreSchema>;

interface AggregatedCompactionResponse {
  responseId?: string;
  createdAt?: number;
  model?: string;
  outputText: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

interface CompactionAggregationResult {
  meta: ResponseMeta;
  body: Buffer;
}

function normalizeCompactionSummaryText(outputText: string): string {
  const trimmed = outputText.trim();
  if (!trimmed) return "";

  const start = trimmed.indexOf("<summary>");
  const end = trimmed.indexOf("</summary>");

  if (start !== -1) {
    if (end !== -1 && end > start) {
      return trimmed.slice(start, end + "</summary>".length).trim();
    }
    return `${trimmed.slice(start).trim()}\n</summary>`;
  }

  return `<summary>\n${trimmed}\n</summary>`;
}

function hasUsablePartialCompactionSummary(outputText: string, minChars: number): boolean {
  const normalized = normalizeCompactionSummaryText(outputText);
  if (!normalized) return false;
  const textOnly = normalized.replace(/<\/?summary>/g, "").trim();
  return textOnly.length >= minChars;
}

function buildCompactionJsonResponse(
  aggregated: AggregatedCompactionResponse,
  fallbackModel?: string,
): Record<string, unknown> {
  const outputText = normalizeCompactionSummaryText(aggregated.outputText);

  return {
    id: aggregated.responseId ?? `resp_${Date.now()}`,
    object: "response",
    created_at: aggregated.createdAt ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: aggregated.model ?? fallbackModel ?? "unknown",
    output: [
      {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: outputText,
          },
        ],
      },
    ],
    usage: {
      input_tokens: aggregated.usage?.input_tokens ?? 0,
      output_tokens: aggregated.usage?.output_tokens ?? 0,
      total_tokens:
        aggregated.usage?.total_tokens ??
        (aggregated.usage?.input_tokens ?? 0) + (aggregated.usage?.output_tokens ?? 0),
    },
  };
}

function parseSseBlock(block: string): { event?: string; data?: string } {
  const lines = block.split("\n").filter((line) => line.length > 0);
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim();
    let value = line.slice(sep + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }

  return {
    event: eventName,
    data: dataLines.length > 0 ? dataLines.join("\n") : undefined,
  };
}

function appendOutputTextFromValue(target: AggregatedCompactionResponse, value: unknown): void {
  if (typeof value === "string") {
    target.outputText += value;
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendOutputTextFromValue(target, item);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  const record = value as Record<string, unknown>;

  if (record.type === "output_text" && typeof record.text === "string") {
    target.outputText += record.text;
  }

  if (typeof record.delta === "string") {
    target.outputText += record.delta;
  }

  if (record.part) {
    appendOutputTextFromValue(target, record.part);
  }

  if (record.item) {
    appendOutputTextFromValue(target, record.item);
  }

  if (record.content) {
    appendOutputTextFromValue(target, record.content);
  }

  if (record.output) {
    appendOutputTextFromValue(target, record.output);
  }
}

function buildCompactionGatewayFailureResult(params: {
  meta: ResponseMeta;
  requestContentLength: number;
  serverAnomalyThreshold: number;
}): CompactionAggregationResult {
  const isServerAnomaly = params.requestContentLength < params.serverAnomalyThreshold;
  const body = isServerAnomaly ? buildServerAnomalyBody() : buildContextLengthExceededBody();

  return {
    meta: {
      statusCode: isServerAnomaly ? 500 : 400,
      statusMessage: isServerAnomaly ? "Internal Server Error" : "Bad Request",
      headers: {
        ...(params.meta.headers ?? {}),
        "content-type": "application/json; charset=utf-8",
      },
    },
    body: Buffer.from(JSON.stringify(body), "utf-8"),
  };
}

async function aggregateCompactionSseResponse(params: {
  body: ReadableStream<Uint8Array>;
  meta: ResponseMeta;
  requestContentLength: number;
  serverAnomalyThreshold: number;
  fallbackModel?: string;
  maxWaitMs?: number;
  minPartialChars?: number;
}): Promise<CompactionAggregationResult> {
  const reader = params.body.getReader();
  const decoder = new TextDecoder();
  let bufferedText = "";
  const aggregated: AggregatedCompactionResponse = {
    model: params.fallbackModel,
    outputText: "",
  };
  const startedAt = Date.now();

  const finalize = (): CompactionAggregationResult => ({
    meta: {
      statusCode: 200,
      statusMessage: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
    },
    body: Buffer.from(
      JSON.stringify(buildCompactionJsonResponse(aggregated, params.fallbackModel)),
      "utf-8",
    ),
  });

  const tryFinalizePartial = async (
    reason: string,
  ): Promise<CompactionAggregationResult | null> => {
    if (
      hasUsablePartialCompactionSummary(
        aggregated.outputText,
        params.minPartialChars ?? COMPACTION_MIN_PARTIAL_CHARS,
      )
    ) {
      await reader.cancel(reason).catch(() => undefined);
      return finalize();
    }
    return null;
  };

  const readNextChunk = async (timeoutMs?: number) => {
    if (timeoutMs === undefined) {
      return {
        timedOut: false as const,
        ...(await reader.read()),
      };
    }

    return await new Promise<
      | { timedOut: true }
      | { timedOut: false; value: Uint8Array | undefined; done: boolean }
    >((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ timedOut: true });
      }, timeoutMs);

      reader.read().then(
        ({ value, done }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve({ timedOut: false, value, done });
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  };

  const processEventBlock = async (
    block: string,
  ): Promise<"continue" | "done" | CompactionAggregationResult> => {
    const { event, data } = parseSseBlock(block);
    if (!data) return "continue";

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return "continue";
    }

    const eventType = event ?? (typeof parsed.type === "string" ? parsed.type : undefined);

    if (eventType === "error" || eventType === "response.failed") {
      const rewritten = rewriteResponse({
        meta: params.meta,
        body: Buffer.from(`${block}\n\n`, "utf-8"),
        requestContentLength: params.requestContentLength,
        serverAnomalyThreshold: params.serverAnomalyThreshold,
      });

      if (rewritten.rewritten) {
        return {
          meta: rewritten.meta,
          body: rewritten.body,
        };
      }

      return buildCompactionGatewayFailureResult({
        meta: params.meta,
        requestContentLength: params.requestContentLength,
        serverAnomalyThreshold: params.serverAnomalyThreshold,
      });
    }

    if (eventType === "response.created") {
      const response = parsed.response as Record<string, unknown> | undefined;
      if (response) {
        aggregated.responseId =
          typeof response.id === "string" ? response.id : aggregated.responseId;
        aggregated.createdAt =
          typeof response.created_at === "number"
            ? response.created_at
            : aggregated.createdAt;
        aggregated.model =
          typeof response.model === "string" ? response.model : aggregated.model;
      }
      return "continue";
    }

    if (eventType === "response.output_text.delta") {
      const delta = parsed.delta;
      if (typeof delta === "string") {
        aggregated.outputText += delta;
        if (aggregated.outputText.includes("</summary>")) {
          await reader.cancel("compaction_summary_complete").catch(() => undefined);
          return "done";
        }
      }
      return "continue";
    }

    if (
      eventType === "response.output_text.done" ||
      eventType === "response.content_part.done" ||
      eventType === "response.content_part.added" ||
      eventType === "response.output_item.done"
    ) {
      const before = aggregated.outputText.length;
      appendOutputTextFromValue(aggregated, parsed);
      if (
        aggregated.outputText.length !== before &&
        aggregated.outputText.includes("</summary>")
      ) {
        await reader.cancel("compaction_summary_complete").catch(() => undefined);
        return "done";
      }
      return "continue";
    }

    if (eventType === "response.completed") {
      const response = parsed.response as Record<string, unknown> | undefined;
      if (response) {
        aggregated.responseId =
          typeof response.id === "string" ? response.id : aggregated.responseId;
        aggregated.createdAt =
          typeof response.created_at === "number"
            ? response.created_at
            : aggregated.createdAt;
        aggregated.model =
          typeof response.model === "string" ? response.model : aggregated.model;

        const usage = response.usage as Record<string, unknown> | undefined;
        if (usage) {
          aggregated.usage = {
            input_tokens:
              typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            output_tokens:
              typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            total_tokens:
              typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
          };
        }

        if (!aggregated.outputText) {
          const output = Array.isArray(response.output) ? response.output : [];
          for (const item of output) {
            if (
              typeof item === "object" &&
              item !== null &&
              (item as Record<string, unknown>).type === "message"
            ) {
              const content = (item as Record<string, unknown>).content;
              if (!Array.isArray(content)) continue;
              for (const part of content) {
                if (
                  typeof part === "object" &&
                  part !== null &&
                  (part as Record<string, unknown>).type === "output_text" &&
                  typeof (part as Record<string, unknown>).text === "string"
                ) {
                  aggregated.outputText += (part as Record<string, unknown>).text as string;
                }
              }
            }
          }
        }
      }
      return "done";
    }

    return "continue";
  };

  try {
    while (true) {
      const remainingMs =
        params.maxWaitMs === undefined ? undefined : Math.max(0, params.maxWaitMs - (Date.now() - startedAt));

      const readResult = await readNextChunk(remainingMs);
      if (readResult.timedOut) {
        if (bufferedText.trim()) {
          const trailingResult = await processEventBlock(bufferedText.trim());
          if (trailingResult === "done") {
            return finalize();
          }
          if (trailingResult !== "continue") return trailingResult;
        }

        const partial = await tryFinalizePartial("compaction_partial_timeout");
        if (partial) return partial;
        return buildCompactionGatewayFailureResult({
          meta: params.meta,
          requestContentLength: params.requestContentLength,
          serverAnomalyThreshold: params.serverAnomalyThreshold,
        });
      }

      const { value, done } = readResult;
      if (done) break;
      if (!value) continue;

      bufferedText += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      while (true) {
        const idx = bufferedText.indexOf("\n\n");
        if (idx === -1) break;
        const block = bufferedText.slice(0, idx);
        bufferedText = bufferedText.slice(idx + 2);
        const result = await processEventBlock(block);
        if (result === "done") {
          return finalize();
        }
        if (result !== "continue") return result;
      }

      if (params.maxWaitMs !== undefined && Date.now() - startedAt >= params.maxWaitMs) {
        if (bufferedText.trim()) {
          const trailingResult = await processEventBlock(bufferedText.trim());
          if (trailingResult === "done") {
            return finalize();
          }
          if (trailingResult !== "continue") return trailingResult;
        }

        const partial = await tryFinalizePartial("compaction_partial_timeout");
        if (partial) return partial;
        return buildCompactionGatewayFailureResult({
          meta: params.meta,
          requestContentLength: params.requestContentLength,
          serverAnomalyThreshold: params.serverAnomalyThreshold,
        });
      }
    }

    if (bufferedText.trim()) {
      const result = await processEventBlock(bufferedText.trim());
      if (result === "done") {
        return finalize();
      }
      if (result !== "continue") return result;
    }
  } finally {
    reader.releaseLock();
  }

  if (!aggregated.outputText.trim()) {
    return buildCompactionGatewayFailureResult({
      meta: params.meta,
      requestContentLength: params.requestContentLength,
      serverAnomalyThreshold: params.serverAnomalyThreshold,
    });
  }

  return finalize();
}

function createReplayStreamFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bufferedBytes: Uint8Array[],
): ReadableStream<Uint8Array> {
  let bufferIndex = 0;
  let lockReleased = false;

  const releaseLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    reader.releaseLock();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bufferIndex < bufferedBytes.length) {
        controller.enqueue(bufferedBytes[bufferIndex++]!);
        return;
      }

      const { value, done } = await reader.read();
      if (done) {
        releaseLock();
        controller.close();
        return;
      }

      if (value) {
        controller.enqueue(value);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseLock();
      }
    },
  });
}

async function precheckCompactionSseResponse(params: {
  body: ReadableStream<Uint8Array>;
  meta: ResponseMeta;
  requestContentLength: number;
  serverAnomalyThreshold: number;
}): Promise<
  | { rewritten: { meta: ResponseMeta; body: Buffer } }
  | { body: ReadableStream<Uint8Array> }
> {
  const reader = params.body.getReader();
  const decoder = new TextDecoder();
  let bufferedText = "";
  const bufferedBytes: Uint8Array[] = [];
  let bufferedLen = 0;

  while (bufferedLen < COMPACTION_SSE_PEEK_LIMIT) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      bufferedBytes.push(value);
      bufferedLen += value.byteLength;
      bufferedText += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    }

    const idx = bufferedText.indexOf("\n\n");
    if (idx === -1) {
      continue;
    }

    const firstBlock = bufferedText.slice(0, idx);
    const rewritten = rewriteResponse({
      meta: params.meta,
      body: Buffer.from(`${firstBlock}\n\n`, "utf-8"),
      requestContentLength: params.requestContentLength,
      serverAnomalyThreshold: params.serverAnomalyThreshold,
    });

    if (rewritten.rewritten) {
      try {
        await reader.cancel("compaction_error_rewritten");
      } finally {
        reader.releaseLock();
      }
      return { rewritten: { meta: rewritten.meta, body: rewritten.body } };
    }

    return { body: createReplayStreamFromReader(reader, bufferedBytes) };
  }

  if (bufferedText.trim()) {
    const rewritten = rewriteResponse({
      meta: params.meta,
      body: Buffer.from(bufferedText, "utf-8"),
      requestContentLength: params.requestContentLength,
      serverAnomalyThreshold: params.serverAnomalyThreshold,
    });

    if (rewritten.rewritten) {
      try {
        await reader.cancel("compaction_error_rewritten");
      } finally {
        reader.releaseLock();
      }
      return { rewritten: { meta: rewritten.meta, body: rewritten.body } };
    }
  }

  return { body: createReplayStreamFromReader(reader, bufferedBytes) };
}

function createHeartbeatCompactionJsonStream(params: {
  body: ReadableStream<Uint8Array>;
  meta: ResponseMeta;
  requestContentLength: number;
  serverAnomalyThreshold: number;
  fallbackModel?: string;
  logger: PluginLogger;
  heartbeatMs: number;
  maxWaitMs: number;
  minPartialChars: number;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      controller.enqueue(encoder.encode(" "));

      const heartbeatId = setInterval(() => {
        if (!closed) {
          controller.enqueue(encoder.encode(" "));
        }
      }, params.heartbeatMs);

      const finish = (body: Buffer) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatId);
        controller.enqueue(body);
        controller.close();
      };

      const fail = (error: unknown) => {
        params.logger.info(`Compaction aggregation fallback: ${String(error)}`);
        const fallback = buildCompactionGatewayFailureResult({
          meta: params.meta,
          requestContentLength: params.requestContentLength,
          serverAnomalyThreshold: params.serverAnomalyThreshold,
        });
        finish(fallback.body);
      };

      void aggregateCompactionSseResponse({
        body: params.body,
        meta: params.meta,
        requestContentLength: params.requestContentLength,
        serverAnomalyThreshold: params.serverAnomalyThreshold,
        fallbackModel: params.fallbackModel,
        maxWaitMs: params.maxWaitMs,
        minPartialChars: params.minPartialChars,
      })
        .then((result) => finish(result.body))
        .catch(fail);
    },
    async cancel(reason) {
      await params.body.cancel(reason).catch(() => undefined);
    },
  });
}

export interface DroidPluginOptions {
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 日志目录（可选） */
  logDir?: string;
  /** 服务器异常检测阈值（字节） */
  serverAnomalyThreshold?: number;
  /** compaction 聚合时发送空白 heartbeat 的间隔（毫秒） */
  compactionHeartbeatMs?: number;
  /** compaction 聚合允许等待的最长时间（毫秒） */
  compactionMaxWaitMs?: number;
  /** compaction 超时后允许返回 partial summary 的最小字符数 */
  compactionMinPartialChars?: number;
  /** 标准请求在本地提前触发 compact 的阈值（字节），默认禁用，小于等于 0 时禁用 */
  preemptiveContextLengthThreshold?: number;
  /** 将 499 Client Closed Request 重写为 context_length_exceeded */
  rewrite499ToContextLengthExceeded?: boolean;
}

/**
 * 创建 Droid 插件
 *
 * @example
 * ```ts
 * import { createDroidPlugin } from "@jixo/proxy-plugin-openai4droid";
 * import { definePlugin } from "@jixo/proxy-plugin";
 *
 * definePlugin(createDroidPlugin({ debug: true }));
 * ```
 */
export function createDroidPlugin(options: DroidPluginOptions = {}): ProxyPlugin<DroidStore> {
  const {
    debug,
    logDir,
    serverAnomalyThreshold = DEFAULT_SERVER_ANOMALY_THRESHOLD,
    compactionHeartbeatMs = COMPACTION_HEARTBEAT_MS,
    compactionMaxWaitMs = COMPACTION_MAX_WAIT_MS,
    compactionMinPartialChars = COMPACTION_MIN_PARTIAL_CHARS,
    preemptiveContextLengthThreshold = DEFAULT_PREEMPTIVE_CONTEXT_LENGTH_THRESHOLD,
    rewrite499ToContextLengthExceeded = false,
  } = options;

  const logger: PluginLogger = createLogger({
    name: "openai4droid",
    debug,
    logDir,
  });

  return {
    name: "openai4droid",
    storeSchema: DroidStoreSchema,

    shouldProcessRequest(meta: RequestMeta): PrecheckResult {
      const headers = normalizeHeaders(meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();
      // Only process JSON requests (potential Droid requests)
      if (!contentType.includes("application/json")) {
        return false;
      }
      return true;
    },

    shouldProcessResponse(meta: ResponseMeta, requestMeta?: RequestMeta): PrecheckResult {
      // Always need to check response for activated requests (determined by store in onResponse)
      // Since we can't access store here, we check if request had JSON content-type
      const reqHeaders = normalizeHeaders(requestMeta?.headers) ?? {};
      const reqContentType = (reqHeaders["content-type"] ?? "").toString().toLowerCase();
      if (!reqContentType.includes("application/json")) {
        return false;
      }

      // Empty gateway errors may have no content-type. We still want response hook
      // to rewrite them into structured errors for Droid.
      if (
        meta.statusCode === 502 ||
        meta.statusCode === 503 ||
        meta.statusCode === 504 ||
        (rewrite499ToContextLengthExceeded && meta.statusCode === 499)
      ) {
        return true;
      }

      // Check response content-type: we handle both JSON and SSE
      const resHeaders = normalizeHeaders(meta.headers) ?? {};
      const resContentType = (resHeaders["content-type"] ?? "").toString().toLowerCase();
      if (resContentType.includes("application/json") || resContentType.includes("text/event-stream")) {
        return true;
      }
      return false;
    },

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      const headers = normalizeHeaders(params.meta.headers) ?? {};

      // Only read body when it might be a droid request (best-effort heuristic)
      const contentType = (headers["content-type"] ?? "").toString();
      if (!contentType.toLowerCase().includes("application/json")) {
        return null;
      }

      const bodyBufferPromise = readStreamToBuffer(params.body);

      logger.debug(`Processing request: ${params.meta.method} ${params.meta.url}`);

      const bodyBuffer = await bodyBufferPromise;
      const bodyText = bodyBuffer.toString("utf-8");
      let parsedBody: Parameters<typeof isNativeSummarizerRequest>[0] | null = null;
      try {
        parsedBody = JSON.parse(bodyText) as Parameters<typeof isNativeSummarizerRequest>[0];
      } catch {
        parsedBody = null;
      }

      const result = rewriteRequest({ headers, body: bodyText });

      if (!result.headers && !result.body) {
        logger.debug("Not a Droid request, passing through");
        return null;
      }

      logger.debug("Rewritten request successfully");

      // 记录重写详情
      if (debug) {
        logger.logToFile("request-rewrite", {
          original: {
            method: params.meta.method,
            url: params.meta.url,
            headers,
            bodyPreview: bodyText.substring(0, 500),
          },
          rewritten: {
            headers: result.headers,
            bodyPreview: result.body?.substring(0, 500),
          },
        });
      }

      // 使用 store 标记请求已被转换（用于 onResponse 判断）
      const requestBodyLength = result.body
        ? Buffer.byteLength(result.body, "utf-8")
        : bodyBuffer.length;

      const isCompactionRequest = parsedBody && isNativeSummarizerRequest(parsedBody);
      const shouldPreemptivelyCompact =
        Boolean(parsedBody && isDroidRequest(parsedBody)) &&
        !isCompactionRequest &&
        preemptiveContextLengthThreshold > 0 &&
        requestBodyLength >= preemptiveContextLengthThreshold;

      if (shouldPreemptivelyCompact) {
        logger.info(
          `Short-circuiting oversized Droid request (${requestBodyLength} bytes) as context_length_exceeded`,
        );

        const responseBody = Buffer.from(JSON.stringify(buildContextLengthExceededBody()), "utf-8");
        return {
          respondWith: {
            statusCode: 400,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(responseBody.length),
            },
            body: responseBody,
          },
        };
      }

      const finalHeaders = params.store
        ? params.store.set(
            {
              activated: true,
              requestBodyLength,
              requestKind:
                isCompactionRequest ? "compaction" : "standard",
            },
            result.headers ?? headers,
          )
        : result.headers;

      return {
        meta: finalHeaders ? { headers: finalHeaders } : undefined,
        body: result.body ? streamFromBuffer(Buffer.from(result.body, "utf-8")) : undefined,
      };
    },

    async onResponse(params: ResponseHookParams<DroidStore>): Promise<ResponseHookResult | null> {
      // 只处理被 onRequest 转换过的请求
      const store = params.store?.get();
      if (!store?.activated) {
        return null;
      }

      logger.debug(`Processing response: ${params.meta.statusCode}`);

      if (rewrite499ToContextLengthExceeded && params.meta.statusCode === 499) {
        logger.info("Rewriting 499 to context_length_exceeded");
        return {
          meta: {
            statusCode: 400,
            statusMessage: "Bad Request",
            headers: { "content-type": "application/json" },
          },
          body: streamFromBuffer(Buffer.from(JSON.stringify(buildContextLengthExceededBody()))),
        };
      }

      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();

      if (store.requestKind === "compaction" && contentType.includes("text/event-stream")) {
        const prechecked = await precheckCompactionSseResponse({
          body: params.body,
          meta: params.meta,
          requestContentLength: store.requestBodyLength,
          serverAnomalyThreshold,
        });

        if ("rewritten" in prechecked) {
          return {
            meta: prechecked.rewritten.meta,
            body: streamFromBuffer(prechecked.rewritten.body),
          };
        }

        return {
          meta: {
            statusCode: 200,
            statusMessage: "OK",
            headers: { "content-type": "application/json; charset=utf-8" },
          },
          body: createHeartbeatCompactionJsonStream({
            body: prechecked.body,
            meta: params.meta,
            requestContentLength: store.requestBodyLength,
            serverAnomalyThreshold,
            fallbackModel: headers["x-upstream-model"]?.toString(),
            logger,
            heartbeatMs: compactionHeartbeatMs,
            maxWaitMs: compactionMaxWaitMs,
            minPartialChars: compactionMinPartialChars,
          }),
        };
      }

      // SSE: only inspect the first event; if it's error, rewrite to single error event and close.
      if (contentType.includes("text/event-stream")) {
        const reader = params.body.getReader();
        const decoder = new TextDecoder();
        let bufferedText = "";
        let bufferedBytes: Uint8Array[] = [];
        let bufferedLen = 0;
        const MAX_PEEK_BYTES = 64 * 1024;

        const tryExtractFirstBlock = () => {
          const normalized = bufferedText.replace(/\r\n/g, "\n");
          const idx = normalized.indexOf("\n\n");
          if (idx === -1) return null;
          return { normalized, idx };
        };

        while (bufferedLen < MAX_PEEK_BYTES) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            bufferedBytes.push(value);
            bufferedLen += value.byteLength;
            bufferedText += decoder.decode(value, { stream: true });
          }
          const extracted = tryExtractFirstBlock();
          if (extracted) {
            const { normalized, idx } = extracted;
            const firstBlock = normalized.slice(0, idx);
            const lines = firstBlock.split("\n").filter((l) => l.length > 0);
            let eventName: string | undefined;
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith(":")) continue;
              const sep = line.indexOf(":");
              if (sep === -1) continue;
              const field = line.slice(0, sep).trim();
              let value = line.slice(sep + 1);
              if (value.startsWith(" ")) value = value.slice(1);
              if (field === "event") eventName = value;
              if (field === "data") dataLines.push(value);
            }

            if (eventName === "error" && dataLines.length > 0) {
              const data = dataLines.join("\n");
              const result = rewriteResponse({
                meta: params.meta,
                body: Buffer.from(data, "utf-8"),
                requestContentLength: store.requestBodyLength,
                serverAnomalyThreshold,
              });

              const payloadText = result.rewritten ? result.body.toString("utf-8") : data;
              const sseLines = payloadText.split("\n").map((l) => `data: ${l}`);
              const out = [`event: error`, ...sseLines, "", ""].join("\n");

              await reader.cancel().catch(() => undefined);
              return {
                meta: {
                  headers: {
                    ...(params.meta.headers ?? {}),
                    "content-type": "text/event-stream; charset=utf-8",
                  },
                },
                body: streamFromBuffer(Buffer.from(out, "utf-8")),
              };
            }

            // Not error: passthrough, re-create stream with buffered bytes + remaining reader
            const passthrough = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of bufferedBytes) controller.enqueue(chunk);
              },
              async pull(controller) {
                const { value, done } = await reader.read();
                if (done) {
                  controller.close();
                  return;
                }
                if (value) controller.enqueue(value);
              },
              cancel(reason) {
                return reader.cancel(reason);
              },
            });
            return { body: passthrough };
          }
        }

        // Peek limit reached or stream ended before block: passthrough
        const passthrough = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of bufferedBytes) controller.enqueue(chunk);
          },
          async pull(controller) {
            const { value, done } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            if (value) controller.enqueue(value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return { body: passthrough };
      }

      const bodyBuffer = await readStreamToBuffer(params.body);
      const result = rewriteResponse({
        meta: params.meta,
        body: bodyBuffer,
        requestContentLength: store.requestBodyLength,
        serverAnomalyThreshold,
      });

      if (!result.rewritten) {
        return null;
      }

      logger.debug(`Response rewritten (source: ${result.source})`);

      // 记录重写详情
      if (debug) {
        logger.logToFile("response-rewrite", {
          original: {
            statusCode: params.meta.statusCode,
            bodyPreview: bodyBuffer.toString("utf-8").substring(0, 500),
          },
          rewritten: {
            statusCode: result.meta.statusCode,
            bodyPreview: result.body.toString("utf-8").substring(0, 500),
            source: result.source,
          },
        });
      }

      return {
        meta: result.meta,
        body: streamFromBuffer(result.body),
      };
    },
  };
}
