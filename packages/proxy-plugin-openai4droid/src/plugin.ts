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
import { normalizeHeaders, createLogger } from "@jixo/proxy-plugin";
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

    onRequest(params: RequestHookParams): RequestHookResult | null {
      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const bodyText = params.body.toString("utf-8");

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
        : params.body.length;
      const finalHeaders = params.store
        ? params.store.set({ activated: true, requestBodyLength }, result.headers ?? headers)
        : result.headers;

      return {
        meta: finalHeaders ? { headers: finalHeaders } : undefined,
        body: result.body ? Buffer.from(result.body, "utf-8") : undefined,
      };
    },

    onResponse(params: ResponseHookParams<DroidStore>): ResponseHookResult | null {
      // 只处理被 onRequest 转换过的请求
      const store = params.store?.get();
      if (!store?.activated) {
        return null;
      }

      logger.debug(`Processing response: ${params.meta.statusCode}`);

      const result = rewriteResponse({
        meta: params.meta,
        body: params.body,
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
            bodyPreview: params.body.toString("utf-8").substring(0, 500),
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
        body: result.body,
      };
    },
  };
}
