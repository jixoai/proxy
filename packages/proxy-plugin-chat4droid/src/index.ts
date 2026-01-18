#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-chat4droid
 *
 * Droid 插件：将 Anthropic Messages API 请求转换为 OpenAI Chat Completions 请求（用于 Hicap OpenAI 接口）
 * 并将 OpenAI Chat Completions 响应（含 SSE）转换回 Anthropic Messages API 格式。
 */

import { createDroidPlugin } from "./plugin";

export { createDroidPlugin, type DroidPluginOptions } from "./plugin";
export { isAnthropicMessagesRequest, rewriteRequest } from "./request-converter";
export { convertChatCompletionResponseToAnthropicMessage } from "./response-converter";
export { convertChatCompletionSSEToAnthropicSSEStream } from "./sse-converter";
export type { AnthropicMessagesRequest, OpenAIChatCompletionRequest } from "./types";

// 作为独立进程运行时启动服务器
if (import.meta.main) {
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  void debug;
  throw new Error(
    `[chat4droid] standalone plugin server mode is no longer supported: hooks are now in-process and streaming-native.`,
  );
}

