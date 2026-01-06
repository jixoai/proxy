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
  PluginLogger,
} from "@jixo/proxy-plugin";
import { normalizeHeaders, createLogger, readStreamToBuffer, streamFromBuffer } from "@jixo/proxy-plugin";
import { rewriteRequest } from "./rewriter";
import { rewriteResponse } from "./response-rewriter";

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

export interface DroidPluginOptions {
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 日志目录（可选） */
  logDir?: string;
  /** 服务器异常检测阈值（字节），小于此值的请求收到 context_length_exceeded 会被视为服务器异常，默认 680KB */
  serverAnomalyThreshold?: number;
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
  const { debug, logDir, serverAnomalyThreshold = DEFAULT_SERVER_ANOMALY_THRESHOLD } = options;

  const logger: PluginLogger = createLogger({
    name: "anthropic4droid",
    debug,
    logDir,
  });

  return {
    name: "anthropic4droid",
    storeSchema: DroidStoreSchema,

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      const headers = normalizeHeaders(params.meta.headers) ?? {};

      const contentType = (headers["content-type"] ?? "").toString();
      if (!contentType.toLowerCase().includes("application/json")) {
        return null;
      }

      const bodyBuffer = await readStreamToBuffer(params.body);
      const bodyText = bodyBuffer.toString("utf-8");

      logger.debug(`Processing request: ${params.meta.method} ${params.meta.url}`);

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

    async onResponse(params: ResponseHookParams): Promise<ResponseHookResult | null> {
      // 检查请求是否被 Droid 插件处理过
      const storeData = params.store?.get() as DroidStore | null;
      if (!storeData?.activated) {
        logger.debug("Request was not processed by Droid plugin, skipping response rewrite");
        return null;
      }

      logger.debug(`Processing response: ${params.meta.statusCode}`);

      // 优先使用 store 中记录的真实请求体大小，避免 content-length 缺失/不准确导致误判
      const requestContentLength = storeData.requestBodyLength;

      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();
      if (contentType.includes("text/event-stream")) {
        return null;
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
