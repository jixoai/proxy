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
import {
  estimateTokenCount,
  createCountTokensResponse,
  cacheInputTokens,
  extractSessionId,
  extractUsageFromResponse,
  extractUsageFromSSE,
} from "./token-cache";
import { interceptTaskTools } from "./task-interceptor";
import { createConfigFromRequest } from "./task-executor";

/** 插件存储 schema - 标记请求是否被转换，并存储会话信息 */
const Responses4ClaudeCodeStoreSchema = z.object({
  /** 请求已被 responses4claudecode 插件转换 */
  activated: z.literal(true),
  /** 会话 ID，用于 token 缓存 */
  sessionId: z.string().optional(),
  /** 请求中的消息数量，用于计算增量 */
  messageCount: z.number().optional(),
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

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
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

      // 拦截 Task/TaskOutput 工具调用
      // 对于 run_in_background=true 的 Task，我们在本地管理状态并注入 tool_result
      // 对于 TaskOutput，我们查找缓存的结果并注入 tool_result
      let claudeBody = parsedBody as {
        metadata?: { user_id?: string };
        messages?: Array<{ role: string; content: unknown }>;
        model?: string;
      };

      if (claudeBody.messages && Array.isArray(claudeBody.messages)) {
        try {
          const originalMessagesCount = claudeBody.messages.length;

          // 构建执行器配置（模型由 x-target-model header 决定）
          // 从请求 URL 提取 API 端点：/anthropic-codex/v1/messages → 需要转发到后端
          const apiEndpoint = meta.url?.replace(/\/messages$/, "/responses") || undefined;
          const executorConfig = createConfigFromRequest(headers, apiEndpoint);

          const interceptResult = await interceptTaskTools(
            claudeBody.messages as Parameters<typeof interceptTaskTools>[0],
            claudeBody.metadata,
            { executorConfig, enableBackgroundExecution: true }
          );

          // 如果有 tool_result 需要注入，更新 messages
          if (interceptResult.modified && interceptResult.modifiedMessages) {
            logger.debug(`Injected tool_result for Task/TaskOutput tool calls`);

            // 更新 claudeBody 的 messages
            claudeBody = {
              ...claudeBody,
              messages: interceptResult.modifiedMessages as typeof claudeBody.messages,
            };

            // 更新 parsedBody 以便后续转换使用
            parsedBody.messages = interceptResult.modifiedMessages;

            if (debug) {
              logger.logToFile("task-intercept", {
                injectedToolResults: interceptResult.modifiedMessages.length - originalMessagesCount,
                messagesCount: interceptResult.modifiedMessages.length,
              });
            }
          }
        } catch (error) {
          logger.debug(`Error intercepting Task tools: ${error}`);
          // 继续正常处理请求
        }
      }

      // 转换请求
      try {
        const result = rewriteRequest({
          headers,
          body: parsedBody,
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

        // 提取会话信息用于 token 缓存
        // 复用前面已声明的 claudeBody
        const sessionId = extractSessionId(claudeBody.metadata);
        const messageCount = claudeBody.messages?.length || 0;

        // 使用 store 标记请求已被转换，并存储会话信息（用于 onResponse 判断和 token 缓存）
        const finalHeaders = params.store
          ? params.store.set({ activated: true, sessionId, messageCount }, result.headers ?? headers)
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

          // 缓存 input_tokens
          const usage = extractUsageFromResponse(parsed);
          if (usage && storeData?.sessionId) {
            cacheInputTokens(storeData.sessionId, usage.inputTokens, storeData.messageCount || 0);
            logger.debug(`Cached input_tokens: ${usage.inputTokens} for session: ${storeData.sessionId}`);
          }

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

        // 从 SSE 中提取 usage 并缓存
        const usage = extractUsageFromSSE(bodyText);
        if (usage && storeData?.sessionId) {
          cacheInputTokens(storeData.sessionId, usage.inputTokens, storeData.messageCount || 0);
          logger.debug(`Cached input_tokens from SSE: ${usage.inputTokens} for session: ${storeData.sessionId}`);
        }

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
 * 启动插件服务器
 */
export async function startPlugin(): Promise<void> {
  const debug = process.env.DEBUG_RESPONSES4CLAUDECODE === "1";
  const plugin = createResponses4ClaudeCodePlugin({ debug });
  await startPluginServer({ plugin });
}
