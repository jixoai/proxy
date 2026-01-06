/**
 * Codex 插件
 *
 * 将 Codex Responses API 请求转换为 Claude Messages API
 * 将 Claude Messages API SSE 响应转换为 Codex Responses API SSE
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
import {
  normalizeHeaders,
  createLogger,
  safeParseJson,
  readStreamToBuffer,
  streamFromBuffer,
} from "@jixo/proxy-plugin";
import { isCodexRequest, rewriteRequest } from "./request-converter";
import {
  convertSSEResponse,
  shouldConvertToContextLengthError,
  buildCodexContextLengthError,
} from "./response-converter";

/** 插件存储 schema - 标记请求是否被转换 */
const CodexStoreSchema = z.object({
  /** 请求已被 Codex 插件转换 */
  activated: z.literal(true),
});

type CodexStore = z.infer<typeof CodexStoreSchema>;

export interface CodexPluginOptions {
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 日志目录（可选） */
  logDir?: string;
  /** 自定义 metadata.user_id（可选，默认使用 Claude Code 兼容的 ID） */
  userId?: string;
}

/**
 * 尝试解析并验证 Codex 请求
 * @returns 解析后的请求对象，如果不是有效的 Codex 请求则返回 null
 */
function tryParseCodexRequest(body: string): unknown | null {
  if (!body) return null;

  try {
    const parsed = JSON.parse(body);
    return isCodexRequest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 创建 Codex 插件
 *
 * @example
 * ```ts
 * import { createCodexPlugin } from "@jixo/proxy-plugin-anthropic4codex";
 * import { definePlugin } from "@jixo/proxy-plugin";
 *
 * definePlugin(createCodexPlugin({ debug: true }));
 * ```
 */
export function createCodexPlugin(options: CodexPluginOptions = {}): ProxyPlugin<CodexStore> {
  const { debug, logDir, userId } = options;

  const logger: PluginLogger = createLogger({
    name: "anthropic4codex",
    debug,
    logDir,
  });

  return {
    name: "anthropic4codex",
    storeSchema: CodexStoreSchema,

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      const headers = normalizeHeaders(params.meta.headers) ?? {};

      const contentType = (headers["content-type"] ?? "").toString();
      if (!contentType.toLowerCase().includes("application/json")) {
        return null;
      }

      const bodyBuffer = await readStreamToBuffer(params.body);
      const bodyText = bodyBuffer.toString("utf-8");

      logger.debug(`Processing request: ${params.meta.method} ${params.meta.url}`);

      // 解析并验证 Codex 请求（只解析一次）
      const parsedBody = tryParseCodexRequest(bodyText);
      if (!parsedBody) {
        logger.debug("Not a Codex request, passing through");
        return null;
      }

      // 传入已解析的 body，避免重复解析
      const result = rewriteRequest({
        headers,
        body: parsedBody as Parameters<typeof rewriteRequest>[0]["body"],
        userId,
      });

      if (!result.headers && !result.body) {
        logger.debug("Request conversion returned empty result");
        return null;
      }

      logger.debug("Converted Codex request to Claude Messages API");

      // 记录重写详情
      if (debug) {
        logger.logToFile("request-rewrite", {
          original: {
            method: params.meta.method,
            url: params.meta.url,
            headers,
            bodyPreview: bodyText.substring(0, 1000),
          },
          rewritten: {
            headers: result.headers,
            bodyPreview: result.body?.substring(0, 1000),
          },
        });
      }

      // 使用 store 标记请求已被转换（用于 onResponse 判断）
      const finalHeaders = params.store
        ? params.store.set({ activated: true }, result.headers ?? headers)
        : result.headers;

      return {
        meta: finalHeaders ? { headers: finalHeaders } : undefined,
        body: result.body ? streamFromBuffer(Buffer.from(result.body, "utf-8")) : undefined,
      };
    },

    async onResponse(params: ResponseHookParams): Promise<ResponseHookResult | null> {
      // 检查请求是否被 Codex 插件处理过
      const storeData = params.store?.get() as CodexStore | null;
      if (!storeData?.activated) {
        logger.debug("Request was not processed by Codex plugin, skipping response conversion");
        return null;
      }

      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const contentType = headers["content-type"] || "";
      const bodyBuffer = await readStreamToBuffer(params.body);
      const bodyText = bodyBuffer.toString("utf-8");

      logger.debug(`Processing response: ${params.meta.statusCode}, content-type: ${contentType}`);

      // 处理 JSON 错误响应 (非 SSE)
      if (contentType.includes("application/json")) {
        const parsed = safeParseJson(bodyText);

        // 检查是否需要转换为 context_length_exceeded (包括上下文过长和上游请求失败)
        if (parsed && shouldConvertToContextLengthError(parsed)) {
          const err = parsed as { error?: { message?: string } };
          const codexError = buildCodexContextLengthError(err.error?.message);

          logger.debug("Converted Claude error to Codex context_length_exceeded format");

          if (debug) {
            logger.logToFile("error-rewrite", {
              originalMeta: params.meta,
              originalError: parsed,
              rewrittenError: codexError,
            });
          }

          return {
            meta: {
              statusCode: 400,
              statusMessage: "Bad Request",
              headers: { "content-type": "application/json; charset=utf-8" },
            },
            body: streamFromBuffer(Buffer.from(JSON.stringify(codexError), "utf-8")),
          };
        }

        logger.debug("JSON response, not a context length error, passing through");
        return null;
      }

      // 检查 Content-Type 是否为 SSE
      if (!contentType.includes("text/event-stream")) {
        logger.debug("Not an SSE response, passing through");
        return null;
      }

      // 检查是否看起来像 Claude SSE
      if (!bodyText.includes("message_start") && !bodyText.includes("content_block")) {
        // 可能是 SSE 格式的错误 (注意: SSE 格式可能是 "event:error" 或 "event: error")
        if (bodyText.includes("event:error") || bodyText.includes("event: error")) {
          logger.debug("SSE error event detected, processing...");
        } else {
          logger.debug("Not a Claude SSE response, passing through");
          return null;
        }
      }

      try {
        const convertedSSE = convertSSEResponse(bodyText);

        logger.debug("Converted Claude SSE response to Codex format");

        if (debug) {
          logger.logToFile("response-rewrite", {
            originalMeta: params.meta,
            originalBodyPreview: bodyText.substring(0, 1000),
            rewrittenBodyPreview: convertedSSE.substring(0, 1000),
          });
        }

        return {
          meta: params.meta,
          body: streamFromBuffer(Buffer.from(convertedSSE, "utf-8")),
        };
      } catch (error) {
        logger.debug(`SSE conversion error: ${error}`);
        return null;
      }
    },
  };
}
