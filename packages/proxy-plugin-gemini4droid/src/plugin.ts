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
import {
  normalizeHeaders,
  createLogger,
  readStreamToBuffer,
  streamFromBuffer,
} from "@jixo/proxy-plugin";
import { convertRequest, isDroidRequest, extractCwd } from "./request-converter";
import { rewriteResponse } from "./response-converter";
import type { AnthropicRequestBody } from "./types";

/**
 * 检测是否为 websearch 请求 (web_search_20250305 工具)
 */
function isWebSearchRequest(body: AnthropicRequestBody): boolean {
  if (!Array.isArray(body.tools)) return false;
  return body.tools.some(
    (t) => "type" in t && t.type === "web_search_20250305"
  );
}

/**
 * 从请求中提取搜索 query
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
  /** 是否为 websearch 请求 */
  isWebSearch: z.boolean().optional(),
  /** websearch 查询 */
  searchQuery: z.string().nullable().optional(),
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

    async onRequest(params: RequestHookParams<GeminiStore>) {
      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const bodyBuffer = await readStreamToBuffer(params.body);
      const bodyText = bodyBuffer.toString("utf-8");

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

      // 确定上游 base URL
      let effectiveBaseUrl = upstreamBaseUrl;
      if (!effectiveBaseUrl && params.meta.url) {
        try {
          const targetUrl = new URL(params.meta.url);
          effectiveBaseUrl = `${targetUrl.protocol}//${targetUrl.host}/v1beta`;
        } catch {
          // ignore
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
      // 使用 store 标记请求已被转换
      const requestBodyLength = result.body
        ? Buffer.byteLength(result.body, "utf-8")
        : bodyBuffer.length;

      // 检测是否为 websearch 请求
      const isWebSearch = isWebSearchRequest(requestBody);
      const searchQuery = isWebSearch ? extractSearchQuery(requestBody) : null;

      const storeData: GeminiStore = {
        activated: true,
        model: requestBody.model || "gemini-2.5-pro",
        requestBodyLength,
        cwd,
        isWebSearch,
        searchQuery,
      };

      const finalHeaders = params.store
        ? params.store.set(storeData, result.headers ?? headers)
        : result.headers;

      const meta: { headers?: Record<string, string | string[]>; url?: string } = {};
      if (finalHeaders) meta.headers = finalHeaders;
      if (result.url) meta.url = result.url;

      return {
        meta: Object.keys(meta).length > 0 ? meta : undefined,
        body: result.body ? streamFromBuffer(Buffer.from(result.body, "utf-8")) : undefined,
      };
    },

    async onResponse(params: ResponseHookParams<GeminiStore>): Promise<ResponseHookResult | null> {
      // 检查请求是否被插件处理过
      const storeData = params.store?.get();
      if (!storeData?.activated) {
        logger.debug("Request was not processed by Gemini plugin, skipping response conversion");
        return null;
      }

      logger.debug(`Processing response: ${params.meta.statusCode}`);

      const bodyBuffer = await readStreamToBuffer(params.body);

      const result = rewriteResponse({
        meta: params.meta,
        body: bodyBuffer,
        model: storeData.model,
        cwd: storeData.cwd,
        isWebSearch: storeData.isWebSearch,
        searchQuery: storeData.searchQuery,
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
            bodyPreview: bodyBuffer.toString("utf-8").substring(0, 500),
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
        body: result.body ? streamFromBuffer(result.body) : undefined,
      };
    },
  };
}
