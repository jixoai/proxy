#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-gemini4droid
 *
 * Droid 到 Gemini 的转换插件，包含：
 * - Request Hook: 将 Droid (Anthropic 格式) 请求转换为 Gemini generateContent 格式
 * - Response Hook: 将 Gemini 响应转换回 Anthropic Messages 格式
 *
 * 使用场景：
 * droid --provider anthropic → proxy → gemini4droid → 用户的 Gemini 服务
 */

import { createProxyServer } from "@jixo/proxy-plugin-server";
import { createGeminiPlugin } from "./plugin";

// 导出插件工厂
export { createGeminiPlugin, type GeminiPluginOptions } from "./plugin";

// 导出请求转换器
export {
  isDroidRequest,
  extractSystemText,
  convertRequest,
  convertRequestBody,
  convertHeaders,
  buildGeminiUrl,
} from "./request-converter";

// 导出响应转换器
export {
  convertResponse,
  convertErrorResponse,
  convertStreamResponse,
  convertStreamChunk,
  createStreamState,
  rewriteResponse,
  isGeminiError,
  isGeminiResponse,
  looksLikeSSE,
  type StreamConverterState,
} from "./response-converter";

// 导出类型
export type {
  // Anthropic types
  AnthropicRequestBody,
  AnthropicResponseBody,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicStopReason,
  AnthropicErrorResponse,
  // Gemini types
  GeminiRequestBody,
  GeminiResponseBody,
  GeminiContent,
  GeminiPart,
  GeminiTextPart,
  GeminiInlineDataPart,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
  GeminiFunctionDeclaration,
  GeminiToolConfig,
  GeminiGenerationConfig,
  GeminiCandidate,
  GeminiFinishReason,
  GeminiErrorResponse,
  // Conversion result types
  RequestConversionResult,
  ResponseConversionResult,
} from "./types";

export const createPlugin = createGeminiPlugin;

// 作为独立进程运行时启动服务器
if (import.meta.main) {
  const config = JSON.parse(process.env.PLUGIN_CONFIG || "{}");
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1" || config.debug;
  
  // 从环境变量或 config 读取 upstream URL
  const upstreamBaseUrl = process.env.GEMINI_UPSTREAM_URL || config.upstreamBaseUrl;

  console.log("Starting gemini4droid plugin server...");
  if (upstreamBaseUrl) {
    console.log(`Upstream URL: ${upstreamBaseUrl}`);
  }

  createProxyServer({
    plugin: createGeminiPlugin({
      ...config,
      debug,
      upstreamBaseUrl,
    }),
  });
}
