/**
 * Droid 插件
 *
 * 包含两个功能：
 * 1. Request Hook: 将 Droid-CLI 格式的请求转换为 Claude-Code-CLI 格式
 * 2. Response Hook: 将上游 "Upstream request failed" 错误重写为 "context_length_exceeded"
 */

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
 * import { createDroidPlugin } from "@jixo/proxy-plugin-droid";
 * import { definePlugin } from "@jixo/proxy-plugin";
 *
 * definePlugin(createDroidPlugin({ debug: true }));
 * ```
 */
export function createDroidPlugin(options: DroidPluginOptions = {}): ProxyPlugin {
  const { debug, logDir } = options;

  const logger: PluginLogger = createLogger({
    name: "droid-plugin",
    debug,
    logDir,
  });

  return {
    name: "droid-plugin",

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

      return {
        meta: result.headers ? { headers: result.headers } : undefined,
        body: result.body ? Buffer.from(result.body, "utf-8") : undefined,
      };
    },

    onResponse(params: ResponseHookParams): ResponseHookResult | null {
      logger.debug(`Processing response: ${params.meta.statusCode}`);

      const result = rewriteResponse({
        meta: params.meta,
        body: params.body,
      });

      if (!result.rewritten) {
        return null;
      }

      logger.debug(`Rewritten response: upstream error -> context_length_exceeded (source: ${result.source})`);

      // 记录重写详情
      logger.logToFile("response-rewrite", {
        originalMeta: params.meta,
        originalBodyPreview: params.body.toString("utf-8").substring(0, 500),
        rewrittenMeta: result.meta,
        rewrittenBody: JSON.parse(result.body.toString("utf-8")),
        source: result.source,
      });

      return {
        meta: result.meta,
        body: result.body,
      };
    },
  };
}
