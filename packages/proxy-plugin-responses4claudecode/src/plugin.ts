/**
 * Responses → Claude Code 转换插件
 *
 * 将 Claude Messages API 请求转换为 OpenAI Responses API 格式，
 * 并将 Responses SSE 响应转换回 Claude SSE 格式。
 */

import { z } from "zod";
import {
  startPluginServer,
  type RequestHookParams,
  type RequestHookResult,
  type ResponseHookParams,
  type ResponseHookResult,
  type ProxyPlugin,
  type PluginLogger,
  normalizeHeaders,
  safeParseJson,
  createLogger,
} from "@jixo/proxy-plugin";
import { isClaudeRequest, rewriteRequest } from "./request-converter";
import { convertSSEResponse, convertErrorResponse, convertSuccessResponse } from "./response-converter";
import { estimateTokenCount, createCountTokensResponse } from "./count-tokens";

/** 插件存储 schema - 标记请求是否被转换 */
const Responses4ClaudeCodeStoreSchema = z.object({
  /** 请求已被 responses4claudecode 插件转换 */
  activated: z.literal(true),
});

type Responses4ClaudeCodeStore = z.infer<typeof Responses4ClaudeCodeStoreSchema>;

export interface Responses4ClaudeCodePluginOptions {
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 日志目录（可选） */
  logDir?: string;
}

function stripBetaQueryParam(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete("beta");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 创建 Responses4ClaudeCode 插件
 *
 * @example
 * ```ts
 * import { createResponses4ClaudeCodePlugin } from "@jixo/proxy-plugin-responses4claudecode";
 * import { definePlugin } from "@jixo/proxy-plugin";
 *
 * definePlugin(createResponses4ClaudeCodePlugin({ debug: true }));
 * ```
 */
export function createResponses4ClaudeCodePlugin(options: Responses4ClaudeCodePluginOptions = {}): ProxyPlugin<Responses4ClaudeCodeStore> {
  const { debug, logDir } = options;

  const logger: PluginLogger = createLogger({
    name: "responses4claudecode",
    debug,
    logDir,
  });

  return {
    name: "responses4claudecode",
    storeSchema: Responses4ClaudeCodeStoreSchema,

    onRequest(params: RequestHookParams): RequestHookResult | null {
      const { meta, body } = params;
      const headers = normalizeHeaders(meta.headers) ?? {};

      // 检查是否有请求体
      if (!body || body.length === 0) {
        logger.debug("No body in request");
        return null;
      }

      const parsedBody = safeParseJson(body.toString("utf-8"));
      if (!parsedBody) {
        logger.debug("Failed to parse request body as JSON");
        return null;
      }

      // 处理 count_tokens 请求 - Codex API 没有这个端点，我们模拟返回
      if (meta.url && meta.url.includes("/count_tokens")) {
        logger.debug("Handling count_tokens request");
        const tokens = estimateTokenCount(parsedBody as Parameters<typeof estimateTokenCount>[0]);
        return {
          respondWith: {
            statusCode: 200,
            body: createCountTokensResponse(tokens),
            headers: {
              "content-type": "application/json",
            },
          },
        };
      }

      if (!isClaudeRequest(parsedBody)) {
        logger.debug("Not a Claude request");
        return null;
      }

      // 转换请求
      try {
        const result = rewriteRequest({
          headers,
          body: body.toString("utf-8"),
        });

        if (!result.body) {
          logger.debug("rewriteRequest returned no body");
          return null;
        }

        logger.debug("Request converted successfully");

        if (debug) {
          const parsedResult = JSON.parse(result.body);
          logger.logToFile("request-rewrite", {
            original: {
              method: meta.method,
              url: meta.url,
              headers,
              bodyPreview: body.toString("utf-8").substring(0, 1000),
            },
            rewritten: {
              model: parsedResult.model,
              instructionsLength: parsedResult.instructions?.length,
              toolsCount: parsedResult.tools?.length,
              bodyPreview: result.body.substring(0, 1000),
            },
          });
        }

        // 使用 store 标记请求已被转换（用于 onResponse 判断）
        const finalHeaders = params.store
          ? params.store.set({ activated: true }, result.headers ?? headers)
          : result.headers;

        return {
          meta: { url: stripBetaQueryParam(meta.url), headers: finalHeaders ?? headers },
          body: Buffer.from(result.body, "utf-8"),
        };
      } catch (error) {
        logger.debug(`Error converting request: ${error}`);
        return null;
      }
    },

    onResponse(params: ResponseHookParams): ResponseHookResult | null {
      // 检查请求是否被 responses4claudecode 插件处理过
      const storeData = params.store?.get() as Responses4ClaudeCodeStore | null;
      if (!storeData?.activated) {
        logger.debug("Request was not processed by responses4claudecode plugin, skipping response conversion");
        return null;
      }

      const { meta, body } = params;
      const headers = normalizeHeaders(meta.headers) ?? {};
      const contentType = headers["content-type"] || "";
      const bodyText = body.toString("utf-8");

      logger.debug(`Processing response: ${meta.statusCode}, content-type: ${contentType}`);

      // 处理 JSON 响应 (非 SSE，包括 stream: false 的成功响应和错误响应)
      if (contentType.includes("application/json")) {
        const parsed = safeParseJson(bodyText);
        if (!parsed) {
          logger.debug("Failed to parse JSON response");
          return null;
        }

        // 先尝试转换成功响应 (stream: false)
        const convertedSuccess = convertSuccessResponse(parsed);
        if (convertedSuccess) {
          logger.debug("Converted Codex success response to Claude format");

          if (debug) {
            logger.logToFile("success-rewrite", {
              originalMeta: meta,
              originalResponse: parsed,
              rewrittenResponse: convertedSuccess,
            });
          }

          return {
            meta,
            body: Buffer.from(JSON.stringify(convertedSuccess), "utf-8"),
          };
        }

        // 再尝试转换错误响应
        const convertedError = convertErrorResponse(parsed);
        if (convertedError) {
          logger.debug("Converted Codex error to Claude error format");

          if (debug) {
            logger.logToFile("error-rewrite", {
              originalMeta: meta,
              originalError: parsed,
              rewrittenError: convertedError,
            });
          }

          return {
            meta,
            body: Buffer.from(JSON.stringify(convertedError), "utf-8"),
          };
        }

        logger.debug("Not a Codex response format, passing through");
        return null;
      }

      // 检查 Content-Type 是否为 SSE
      if (!contentType.includes("text/event-stream")) {
        logger.debug("Not SSE content-type, skipping");
        return null;
      }

      // 检查是否看起来像 Codex SSE (response.created, response.output_item 等)
      if (!bodyText.includes("response.created") && !bodyText.includes("response.output")) {
        // 可能是 SSE 格式的错误
        if (!bodyText.includes("event:error") && !bodyText.includes("event: error")) {
          logger.debug("Not Codex SSE format, skipping");
          return null;
        }
      }

      try {
        const convertedSSE = convertSSEResponse(bodyText);

        logger.debug("SSE converted successfully");

        if (debug) {
          logger.logToFile("response-rewrite", {
            originalMeta: meta,
            originalBodyPreview: bodyText.substring(0, 1000),
            rewrittenBodyPreview: convertedSSE.substring(0, 1000),
          });
        }

        return {
          meta,
          body: Buffer.from(convertedSSE, "utf-8"),
        };
      } catch (error) {
        logger.debug(`Error converting SSE response: ${error}`);
        return null;
      }
    },
  };
}

/**
 * 创建插件实例（兼容旧 API）
 * @deprecated 使用 createResponses4ClaudeCodePlugin 代替
 */
export function createPlugin(): ProxyPlugin<Responses4ClaudeCodeStore> {
  const debug = process.env.DEBUG_RESPONSES4CLAUDECODE === "1";
  return createResponses4ClaudeCodePlugin({ debug });
}

/**
 * 启动插件服务器
 */
export async function startPlugin(): Promise<void> {
  const plugin = createPlugin();
  await startPluginServer({ plugin });
}
