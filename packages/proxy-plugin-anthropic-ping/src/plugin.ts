/**
 * Anthropic Ping 插件
 * 实现 ProxyPlugin 接口，用于集成到代理服务器
 */

import type { ProxyPlugin, RequestHookParams, RequestHookResult, RequestMeta, PrecheckResult } from "@jixo/proxy-plugin";
import { safeParseJson, PrivateHeaders, readStreamToText } from "@jixo/proxy-plugin";
import { AnthropicPingMiddleware } from "./ping-middleware";
import type { PingPluginOptions, AnthropicRequestBody } from "./types";

export interface AnthropicPingPluginOptions extends PingPluginOptions {
  enabled?: boolean;
}

export function createAnthropicPingPlugin(
  options: AnthropicPingPluginOptions = {}
): ProxyPlugin & { middleware: AnthropicPingMiddleware } {
  const enabled = options.enabled ?? true;
  const middleware = new AnthropicPingMiddleware(options);

  const plugin: ProxyPlugin & { middleware: AnthropicPingMiddleware } = {
    name: "anthropic-ping",
    middleware,

    shouldProcessRequest(meta: RequestMeta): PrecheckResult {
      if (!enabled) return false;
      if (!isAnthropicMessagesRequest(meta.url)) {
        return false;
      }
      return true;
    },

    // No response processing needed
    shouldProcessResponse(): PrecheckResult {
      return false;
    },

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      if (!enabled) return null;

      const { meta } = params;

      if (!isAnthropicMessagesRequest(meta.url)) {
        return null;
      }

      const bodyText = await readStreamToText(params.body);
      const parsed = safeParseJson<AnthropicRequestBody>(bodyText);

      if (!parsed || !parsed.messages || parsed.messages.length === 0) {
        return null;
      }

      const headers = normalizeHeaders(meta.headers);
      const targetUrl = meta.url ?? "";
      // 从私有 header 中获取 proxyUrl（用于发送 ping 请求走完整 proxy 流程）
      const proxyUrl = headers[PrivateHeaders.PROXY_URL.toLowerCase()] ?? "";

      const result = middleware.intercept(headers, parsed, proxyUrl, targetUrl);

      // 如果收到结束消息，直接返回 204
      if (result.shouldReturn204) {
        console.log("[AnthropicPing] End message detected, returning 204");
        return {
          respondWith: {
            statusCode: 204,
          },
        };
      }

      // 返回 modified: false 表示处理过但未修改内容
      return { modified: false };
    },
  };

  return plugin;
}

function isAnthropicMessagesRequest(url: string | undefined): boolean {
  if (!url) return false;
  return url.includes("/v1/messages") || url.includes("/anthropic/");
}

function normalizeHeaders(
  headers: Record<string, string | string[]> | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      const normalized = Array.isArray(value) ? value[0] : value;
      if (normalized !== undefined) {
        result[key.toLowerCase()] = normalized;
      }
    }
  }

  return result;
}
