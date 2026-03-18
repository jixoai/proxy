/**
 * Droid 插件
 *
 * 包含两个功能：
 * 1. Request Hook: 将 Droid-CLI 格式的请求转换为 Claude-Code-CLI 格式
 * 2. Response Hook: 将上游 "Upstream request failed" 错误重写为 "context_length_exceeded"
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
import { rewriteRequest, type ModelRewriteConfig } from "./rewriter";
import { rewriteResponse, buildContextLengthExceededBody } from "./response-rewriter";

/** 插件存储 schema - 标记请求是否被转换 */
const DroidStoreSchema = z.object({
  /** 请求已被 Droid 插件转换 */
  activated: z.literal(true),
  /** 该次请求体字节长度（用于 response hook 判断是否为服务器异常） */
  requestBodyLength: z.number().int().nonnegative(),
});

type DroidStore = z.infer<typeof DroidStoreSchema>;

/** 默认服务器异常检测阈值：680KB */
const DEFAULT_SERVER_ANOMALY_THRESHOLD = 680 * 1024;

/** 可重试的 SSE 错误类型 */
const RETRYABLE_SSE_ERROR_TYPES = [
  "permission_error",
  "overloaded_error",
  "rate_limit_error",
];

/**
 * 解析 SSE 文本中的错误事件
 */
function parseSSEErrorEvent(text: string): { type: string; message: string } | null {
  const lines = text.split("\n");
  let isErrorEvent = false;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      const eventName = line.slice(6).trim();
      isErrorEvent = eventName === "error";
    } else if (line.startsWith("data:") && isErrorEvent) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!isErrorEvent || dataLines.length === 0) {
    return null;
  }

  try {
    const data = JSON.parse(dataLines.join(""));
    if (data?.type === "error" && data?.error?.type) {
      return {
        type: data.error.type,
        message: data.error.message || "",
      };
    }
  } catch {
    // ignore parse error
  }
  return null;
}

/**
 * 检查 SSE 错误类型是否可重试
 */
function isRetryableSSEError(errorType: string): boolean {
  return RETRYABLE_SSE_ERROR_TYPES.includes(errorType);
}

/**
 * 修复部分上游返回的异常 SSE：content_block_* 事件的 index 可能出现 100、然后又从 0 开始等乱序情况，
 * 会导致 Droid 在增量合并时读取到 undefined（例如 evaluating 'Q.type'）。
 *
 * 做法：按“首次出现顺序”重映射 index -> 0..n-1，并对后续 delta/stop 复用同一映射。
 */
function normalizeClaudeSSEContentBlockIndexStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      let pendingCR = false;

      const indexMap = new Map<number, number>();
      let nextIndex = 0;

      const emit = (text: string) => controller.enqueue(encoder.encode(text));

      const appendDecoded = (chunkText: string) => {
        let text = chunkText;

        // Handle CRLF across chunk boundary.
        if (pendingCR) {
          if (text.startsWith("\n")) {
            buffer += "\n";
            text = text.slice(1);
          } else {
            buffer += "\n";
          }
          pendingCR = false;
        }

        if (text.endsWith("\r")) {
          pendingCR = true;
          text = text.slice(0, -1);
        }

        // Normalize newlines to '\n'
        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        buffer += text;
      };

      const processBlock = (block: string) => {
        // Preserve keep-alive empty blocks.
        if (block.length === 0) {
          emit("\n\n");
          return;
        }

        const lines = block.split("\n").filter((l) => l.length > 0);
        let eventName: string | undefined;
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (!eventName || dataLines.length === 0) {
          emit(`${block}\n\n`);
          return;
        }

        const dataStr = dataLines.join("");
        let json: unknown;
        try {
          json = JSON.parse(dataStr);
        } catch {
          emit(`${block}\n\n`);
          return;
        }

        const index = (json as { index?: unknown })?.index;
        if (typeof index !== "number" || !Number.isFinite(index)) {
          emit(`${block}\n\n`);
          return;
        }

        let mapped = indexMap.get(index);
        if (mapped === undefined) {
          mapped = nextIndex++;
          indexMap.set(index, mapped);
        }

        // If the mapping is identity, keep the original block untouched.
        if (mapped === index) {
          emit(`${block}\n\n`);
          return;
        }

        const next = { ...(json as Record<string, unknown>), index: mapped };
        emit(`event: ${eventName}\ndata: ${JSON.stringify(next)}\n\n`);
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          appendDecoded(decoder.decode(value, { stream: true }));

          // Process complete SSE blocks separated by blank line.
          // (buffer already normalized to '\n')
          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            processBlock(block);
          }
        }

        // Flush decoder + pending CR
        appendDecoded(decoder.decode());
        if (pendingCR) {
          buffer += "\n";
          pendingCR = false;
        }

        if (buffer.length > 0) {
          emit(buffer);
        }

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export interface DroidPluginOptions {
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 日志目录（可选） */
  logDir?: string;
  /** model 字段 rewrite 规则 */
  model?: ModelRewriteConfig;
  /** 服务器异常检测阈值（字节），小于此值的请求收到 context_length_exceeded 会被视为服务器异常，默认 680KB */
  serverAnomalyThreshold?: number;
  /** 检测 SSE 流中的可重试错误并返回 502 (默认 false) */
  detectSSEErrors?: boolean;
  /** 规范化 Claude SSE content_block_* 的 index（默认 true） */
  normalizeSSEContentBlockIndex?: boolean;
  /** 将 499 Client Closed Request 转换为 context_length_exceeded (默认 false) */
  rewrite499ToContextLengthExceeded?: boolean;
  /** anthropic-beta header 值，默认 ['claude-code-20250219', 'interleaved-thinking-2025-05-14'] */
  betas?: string[];
}

/**
 * 创建 Droid 插件
 *
 * @example
 * ```ts
 * import { createDroidPlugin } from "@jixo/proxy-plugin-anthropic4droid";
 * import { definePlugin } from "@jixo/proxy-plugin";
 *
 * definePlugin(createDroidPlugin({ debug: true }));
 * ```
 */
export function createDroidPlugin(options: DroidPluginOptions = {}): ProxyPlugin<DroidStore> {
  const {
    debug,
    logDir,
    model,
    serverAnomalyThreshold = DEFAULT_SERVER_ANOMALY_THRESHOLD,
    detectSSEErrors = false,
    normalizeSSEContentBlockIndex = true,
    rewrite499ToContextLengthExceeded = false,
    betas,
  } = options;

  const logger: PluginLogger = createLogger({
    name: "anthropic4droid",
    debug,
    logDir,
  });

  return {
    name: "anthropic4droid",
    storeSchema: DroidStoreSchema,

    shouldProcessRequest(meta: RequestMeta): PrecheckResult {
      const headers = normalizeHeaders(meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();
      if (!contentType.includes("application/json")) {
        return false;
      }
      return true;
    },

    shouldProcessResponse(meta: ResponseMeta, requestMeta?: RequestMeta): PrecheckResult {
      const reqHeaders = normalizeHeaders(requestMeta?.headers) ?? {};
      const reqContentType = (reqHeaders["content-type"] ?? "").toString().toLowerCase();
      if (!reqContentType.includes("application/json")) {
        return false;
      }
      // 处理 499 错误
      if (rewrite499ToContextLengthExceeded && meta.statusCode === 499) {
        return true;
      }
      const resHeaders = normalizeHeaders(meta.headers) ?? {};
      const resContentType = (resHeaders["content-type"] ?? "").toString().toLowerCase();
      // 处理 SSE 响应以检测错误
      if (detectSSEErrors && resContentType.includes("text/event-stream")) {
        return true;
      }
      // 处理 SSE 响应以规范化 index
      if (normalizeSSEContentBlockIndex && resContentType.includes("text/event-stream")) {
        return true;
      }
      if (resContentType.includes("application/json")) {
        return true;
      }
      return false;
    },

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      const headers = normalizeHeaders(params.meta.headers) ?? {};

      const contentType = (headers["content-type"] ?? "").toString();
      if (!contentType.toLowerCase().includes("application/json")) {
        return null;
      }

      const bodyBuffer = await readStreamToBuffer(params.body);
      const bodyText = bodyBuffer.toString("utf-8");

      logger.debug(`Processing request: ${params.meta.method} ${params.meta.url}`);

      const result = rewriteRequest({ headers, body: bodyText, config: { model, betas } });

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
      const finalHeaders = params.store
        ? params.store.set({ activated: true, requestBodyLength }, result.headers ?? headers)
        : result.headers;

      return {
        meta: finalHeaders ? { headers: finalHeaders } : undefined,
        body: result.body ? streamFromBuffer(Buffer.from(result.body, "utf-8")) : undefined,
      };
    },

    async onResponse(params: ResponseHookParams): Promise<ResponseHookResult | null> {
      // 检查请求是否被 Droid 插件处理过
      const storeData = params.store?.get() as DroidStore | null;
      if (!storeData?.activated) {
        logger.debug("Request was not processed by Droid plugin, skipping response rewrite");
        return null;
      }

      logger.debug(`Processing response: ${params.meta.statusCode}`);

      // 处理 499 错误：转换为 context_length_exceeded
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

      // 优先使用 store 中记录的真实请求体大小，避免 content-length 缺失/不准确导致误判
      const requestContentLength = storeData.requestBodyLength;

      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();

      // SSE 响应：优先处理（保持 streaming）
      if (contentType.includes("text/event-stream")) {
        // 保持旧行为：detectSSEErrors 会读取全量流（非 streaming），仅用于错误检测
        if (detectSSEErrors) {
          const bodyBuffer = await readStreamToBuffer(params.body);
          const text = bodyBuffer.toString("utf-8");
          const errorEvent = parseSSEErrorEvent(text);

          if (errorEvent && isRetryableSSEError(errorEvent.type)) {
            logger.info(`SSE error detected: ${errorEvent.type} - ${errorEvent.message}`);
            return {
              meta: {
                statusCode: 502,
                statusMessage: "Bad Gateway",
                headers: { "content-type": "application/json" },
              },
              body: streamFromBuffer(
                Buffer.from(
                  JSON.stringify({
                    type: "error",
                    error: errorEvent,
                    source: "sse_error_detected",
                  }),
                ),
              ),
            };
          }

          if (!normalizeSSEContentBlockIndex) {
            return { body: streamFromBuffer(bodyBuffer) };
          }

          return { body: normalizeClaudeSSEContentBlockIndexStream(streamFromBuffer(bodyBuffer)) };
        }

        if (!normalizeSSEContentBlockIndex) {
          return null;
        }

        return { body: normalizeClaudeSSEContentBlockIndexStream(params.body) };
      }

      const bodyBuffer = await readStreamToBuffer(params.body);

      const result = rewriteResponse({
        meta: params.meta,
        body: bodyBuffer,
        requestContentLength,
        serverAnomalyThreshold,
      });

      if (!result.rewritten) {
        return null;
      }

      if (result.source === "server_anomaly") {
        logger.debug(
          `Rewritten response: 200+context_length_exceeded with small request -> 500 (server anomaly)`,
        );
      } else {
        logger.debug(
          `Rewritten response: upstream error -> context_length_exceeded (source: ${result.source})`,
        );
      }

      // 记录重写详情
      logger.logToFile("response-rewrite", {
        originalMeta: params.meta,
        originalBodyPreview: bodyBuffer.toString("utf-8").substring(0, 500),
        rewrittenMeta: result.meta,
        rewrittenBody: JSON.parse(result.body.toString("utf-8")),
        source: result.source,
      });

      return {
        meta: result.meta,
        body: streamFromBuffer(result.body),
      };
    },
  };
}
