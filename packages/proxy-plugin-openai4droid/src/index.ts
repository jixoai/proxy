#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-openai4droid
 *
 * Droid 请求重写插件：
 * - Request Hook: 将 Droid-CLI 的 instructions 内联到 input，并替换为 Codex instructions
 * - Request Hook: 检测 websearch 请求并添加 CODEX_INSTRUCTIONS
 * - Response Hook: 处理错误响应（context_length_exceeded 等）
 * 
 * 注意：websearch 响应解析由 droid-patch 的 websearch-native.ts 处理
 */

import { createDroidPlugin } from "./plugin";

// 导出公共 API
export { createDroidPlugin, type DroidPluginOptions } from "./plugin";
export { rewriteRequest, hasWebSearchTool, isDroidRequest, isWebSearchRequest } from "./rewriter";
export { rewriteResponse } from "./response-rewriter";
export type { RequestBody, RewriteResult, AnyTool, WebSearchTool, FunctionTool } from "./types";

// 作为独立进程运行时启动服务器
if (import.meta.main) {
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  void debug;
  throw new Error(
    `[openai4droid] standalone plugin server mode is no longer supported: hooks are now in-process and streaming-native.`,
  );
}
