#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-anthropic4droid
 *
 * Droid 插件，包含：
 * - Request Hook: 将 Droid-CLI 格式的请求转换为 Claude-Code-CLI 格式
 * - Response Hook: 将上游错误重写为 context_length_exceeded 以触发 auto-compact
 */

import { createDroidPlugin } from "./plugin";

// 导出公共 API
export { createDroidPlugin, type DroidPluginOptions } from "./plugin";

// Request rewriter
export {
  isDroidRequest,
  extractSystemText,
  rewriteRequest,
  rewriteRequestBody,
  rewriteHeaders,
  mergeDuplicateSystemReminders,
  normalizeContentArray,
  replaceSystemReminderSection,
} from "./rewriter";

// Response rewriter
export {
  isUpstreamRequestFailedError,
  buildContextLengthExceededBody,
  looksLikeSse,
  extractJsonFromSseError,
  rewriteResponse,
  type ResponseRewriteResult,
} from "./response-rewriter";

// Types
export type { RequestBody, Message, TextBlock, RewriteResult } from "./types";

// 作为独立进程运行时启动服务器
if (import.meta.main) {
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  void debug;
  throw new Error(
    `[anthropic4droid] standalone plugin server mode is no longer supported: hooks are now in-process and streaming-native.`,
  );
}
