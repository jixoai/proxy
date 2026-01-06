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
  PluginLogger,
} from "@jixo/proxy-plugin";
import { normalizeHeaders, createLogger, readStreamToBuffer, streamFromBuffer } from "@jixo/proxy-plugin";
import { rewriteRequest } from "./rewriter";
import { rewriteResponse } from "./response-rewriter";

/** 服务器异常检测阈值（字节） - 小于此大小的请求不应触发 context_length_exceeded */
const SERVER_ANOMALY_THRESHOLD = 10000;

/** 插件存储 schema - 标记请求是否被转换 */
const DroidStoreSchema = z.object({
  /** 请求已被 Droid 插件转换 */
  activated: z.literal(true),
  /** 该次请求体字节长度（用于 response hook 判断是否为服务器异常） */
  requestBodyLength: z.number().int().nonnegative(),
});

type DroidStore = z.infer<typeof DroidStoreSchema>;

export interface DroidPluginOptions {
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 日志目录（可选） */
  logDir?: string;
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
  const { debug, logDir } = options;

  const logger: PluginLogger = createLogger({
    name: "openai4droid",
    debug,
    logDir,
  });

  return {
    name: "openai4droid",
    storeSchema: DroidStoreSchema,

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
      const finalHeaders = params.store
        ? params.store.set({ activated: true, requestBodyLength }, result.headers ?? headers)
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

      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();

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
                serverAnomalyThreshold: SERVER_ANOMALY_THRESHOLD,
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
        serverAnomalyThreshold: SERVER_ANOMALY_THRESHOLD,
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
