/**
 * Gemini4Droid 插件
 *
 * 将 Droid 的 Anthropic 格式请求转换为 Gemini API 格式，
 * 并将 Gemini 响应转换回 Anthropic 格式。
 *
 * 架构：
 * droid (Anthropic provider) → proxy → gemini4droid → 上游 Gemini 服务
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
import { convertRequest, isDroidRequest, extractCwd } from "./request-converter";
import { rewriteResponse } from "./response-converter";
import { executeWebSearch } from "./web-search";
import type { AnthropicRequestBody } from "./types";

/**
 * 检测是否为 Droid 的 websearch 请求
 * 特征：stream: false, tools 只有 web_search_20250305
 */
function isWebSearchRequest(body: AnthropicRequestBody): boolean {
  if (body.stream !== false) return false;
  if (!Array.isArray(body.tools) || body.tools.length !== 1) return false;
  const tool = body.tools[0] as { type?: string };
  return tool.type === "web_search_20250305";
}

/**
 * 从 websearch 请求中提取搜索 query
 */
function extractSearchQuery(body: AnthropicRequestBody): string | null {
  const messages = body.messages || [];
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "user") return null;
  
  let content = "";
  if (typeof lastMsg.content === "string") {
    content = lastMsg.content;
  } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
    const firstBlock = lastMsg.content[0] as { text?: string };
    content = firstBlock?.text || "";
  }
  
  // 提取 "Search the web for: {query}" 中的 query
  const match = content.match(/Search the web for:\s*(.+?)(?:\n|$)/i);
  return match && match[1] ? match[1].trim() : content;
}

/**
 * 处理 websearch 请求，返回非流式响应
 */
function handleWebSearchRequest(
  query: string,
  apiKey: string,
  upstreamUrl: string,
  model: string
): { body: string; headers: Record<string, string> } {
  // 执行搜索
  const searchResponse = executeWebSearch(query, apiKey, upstreamUrl);
  
  // 生成唯一 ID
  const msgId = `msg_ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const serverToolUseId = `srvtoolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  
  // 构建搜索结果条目
  const webSearchResults = searchResponse.results.map((r, i) => ({
    type: "web_search_result",
    title: r.title || `Result ${i + 1}`,
    url: r.url || `https://search.result/${i + 1}`,
    encrypted_content: Buffer.from(r.snippet || "").toString("base64"),
  }));
  
  // 如果没有结果，使用原始响应创建一个
  if (webSearchResults.length === 0) {
    webSearchResults.push({
      type: "web_search_result",
      title: `Search results for: ${query}`,
      url: "https://search.result/1",
      encrypted_content: Buffer.from(searchResponse.responseText).toString("base64"),
    });
  }
  
  // 构建非流式 JSON 响应
  const response = {
    id: msgId,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "server_tool_use",
        id: serverToolUseId,
        name: "web_search",
        input: { query },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: serverToolUseId,
        content: webSearchResults,
      },
      {
        type: "text",
        text: searchResponse.responseText,
      },
    ],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: searchResponse.responseText.length,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: {
        web_search_requests: 1,
      },
    },
  };
  
  return {
    body: JSON.stringify(response),
    headers: {
      "content-type": "application/json",
    },
  };
}

/** 插件存储 schema */
const GeminiStoreSchema = z.object({
  /** 请求已被插件转换 */
  activated: z.literal(true),
  /** 原始请求的 model */
  model: z.string(),
  /** 请求体字节长度 */
  requestBodyLength: z.number().int().nonnegative(),
  /** 当前工作目录，用于修复相对路径 */
  cwd: z.string().nullable(),
  /** API Key（用于 web search） */
  apiKey: z.string().nullable(),
  /** 上游 base URL（用于 web search） */
  upstreamUrl: z.string().nullable(),
});

type GeminiStore = z.infer<typeof GeminiStoreSchema>;

export interface GeminiPluginOptions {
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 日志目录（可选） */
  logDir?: string;
  /**
   * 上游 Gemini API 基础 URL
   * 例如: https://generativelanguage.googleapis.com/v1beta
   */
  upstreamBaseUrl?: string;
}

/**
 * 创建 Gemini4Droid 插件
 *
 * @example
 * ```ts
 * import { createGeminiPlugin } from "@jixo/proxy-plugin-gemini4droid";
 * import { definePlugin } from "@jixo/proxy-plugin";
 *
 * definePlugin(createGeminiPlugin({
 *   debug: true,
 *   upstreamBaseUrl: "https://your-gemini-endpoint.com/v1"
 * }));
 * ```
 */
export function createGeminiPlugin(
  options: GeminiPluginOptions = {}
): ProxyPlugin<GeminiStore> {
  const { debug, logDir, upstreamBaseUrl } = options;

  const logger: PluginLogger = createLogger({
    name: "gemini4droid",
    debug,
    logDir,
  });

  return {
    name: "gemini4droid",
    storeSchema: GeminiStoreSchema,

    onRequest(params: RequestHookParams<GeminiStore>): RequestHookResult | null {
      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const bodyText = params.body.toString("utf-8");

      logger.debug(`Processing request: ${params.meta.method} ${params.meta.url}`);

      // 尝试解析请求体
      let requestBody: AnthropicRequestBody;
      try {
        requestBody = JSON.parse(bodyText) as AnthropicRequestBody;
      } catch {
        logger.debug("Failed to parse request body as JSON, passing through");
        return null;
      }

      // 检测是否为 Droid 请求
      if (!isDroidRequest(requestBody)) {
        logger.debug("Not a Droid request, passing through");
        return null;
      }

      // 确定上游 base URL（websearch 和普通请求都需要）
      let effectiveBaseUrl = upstreamBaseUrl;
      if (!effectiveBaseUrl && params.meta.url) {
        try {
          const targetUrl = new URL(params.meta.url);
          effectiveBaseUrl = `${targetUrl.protocol}//${targetUrl.host}/v1beta`;
        } catch {
          // ignore
        }
      }

      // 提取 API key
      const apiKey = headers["x-api-key"] || null;

      // 特殊处理：Droid 的 websearch 请求
      // 直接执行搜索并返回非流式响应，不经过 Gemini
      if (isWebSearchRequest(requestBody) && apiKey && effectiveBaseUrl) {
        const query = extractSearchQuery(requestBody);
        if (query) {
          logger.debug(`Handling websearch request: ${query}`);
          
          const wsResult = handleWebSearchRequest(
            query,
            apiKey,
            effectiveBaseUrl,
            requestBody.model || "gemini-2.5-pro"
          );
          
          if (debug) {
            logger.logToFile("websearch-intercept", {
              query,
              responsePreview: wsResult.body.substring(0, 500),
            });
          }
          
          // 返回拦截响应（短路请求，直接返回响应）
          return {
            respondWith: {
              statusCode: 200,
              headers: wsResult.headers,
              body: Buffer.from(wsResult.body, "utf-8"),
            },
          };
        }
      }

      // 转换请求
      const result = convertRequest({
        headers,
        body: bodyText,
        upstreamBaseUrl: effectiveBaseUrl,
      });

      if (!result.body) {
        logger.debug("Request conversion returned empty, passing through");
        return null;
      }

      logger.debug("Request converted successfully (Anthropic → Gemini)");

      // 记录转换详情
      if (debug) {
        logger.logToFile("request-convert", {
          original: {
            method: params.meta.method,
            url: params.meta.url,
            headers,
            bodyPreview: bodyText.substring(0, 500),
          },
          converted: {
            url: result.url,
            headers: result.headers,
            bodyPreview: result.body?.substring(0, 500),
          },
        });
      }

      // 提取 cwd 用于修复相对路径
      const cwd = extractCwd(requestBody);
      if (cwd) {
        logger.debug(`Extracted cwd: ${cwd}`);
      }

      // 更新 API key（从转换后的 headers 获取）
      const finalApiKey = result.headers?.["x-goog-api-key"] || apiKey;

      // 使用 store 标记请求已被转换
      const requestBodyLength = result.body
        ? Buffer.byteLength(result.body, "utf-8")
        : params.body.length;

      const storeData: GeminiStore = {
        activated: true,
        model: requestBody.model || "gemini-2.5-pro",
        requestBodyLength,
        cwd,
        apiKey: finalApiKey,
        upstreamUrl: effectiveBaseUrl || null,
      };

      const finalHeaders = params.store
        ? params.store.set(storeData, result.headers ?? headers)
        : result.headers;

      // 构建返回结果
      const hookResult: RequestHookResult = {
        body: result.body ? Buffer.from(result.body, "utf-8") : undefined,
      };

      if (finalHeaders || result.url) {
        hookResult.meta = {};
        if (finalHeaders) {
          hookResult.meta.headers = finalHeaders;
        }
        if (result.url) {
          hookResult.meta.url = result.url;
        }
      }

      return hookResult;
    },

    onResponse(params: ResponseHookParams<GeminiStore>): ResponseHookResult | null {
      // 检查请求是否被插件处理过
      const storeData = params.store?.get();
      if (!storeData?.activated) {
        logger.debug("Request was not processed by Gemini plugin, skipping response conversion");
        return null;
      }

      logger.debug(`Processing response: ${params.meta.statusCode}`);

      const result = rewriteResponse({
        meta: params.meta,
        body: params.body,
        model: storeData.model,
        cwd: storeData.cwd,
        apiKey: storeData.apiKey,
        upstreamUrl: storeData.upstreamUrl,
      });

      if (!result.converted) {
        logger.debug("Response not converted");
        return null;
      }

      logger.debug("Response converted successfully (Gemini → Anthropic)");

      // 记录转换详情
      if (debug) {
        logger.logToFile("response-convert", {
          original: {
            statusCode: params.meta.statusCode,
            bodyPreview: params.body.toString("utf-8").substring(0, 500),
          },
          converted: {
            statusCode: result.statusCode,
            bodyPreview: result.body?.toString("utf-8").substring(0, 500),
          },
        });
      }

      return {
        meta: {
          statusCode: result.statusCode,
          headers: result.headers,
        },
        body: result.body,
      };
    },
  };
}
