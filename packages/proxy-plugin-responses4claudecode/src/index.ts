#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-responses4claudecode
 *
 * Claude Messages API → OpenAI Responses API 转换插件
 *
 * 使用方式：
 * 1. 作为 CLI 运行: bunx @jixo/proxy-plugin-responses4claudecode
 * 2. 作为模块导入: import { createResponses4ClaudeCodePlugin } from "@jixo/proxy-plugin-responses4claudecode"
 */

import { createProxyServer } from "@jixo/proxy-plugin-server";
import { createResponses4ClaudeCodePlugin } from "./plugin";

// 导出公共 API
export { createResponses4ClaudeCodePlugin, type Responses4ClaudeCodePluginOptions } from "./plugin";
export { isClaudeRequest, rewriteRequest, convertRequest } from "./request-converter";
export { SSEStreamConverter, convertSSEResponse, convertErrorResponse, convertSuccessResponse, isCodexSuccessResponse } from "./response-converter";
export * from "./types";
export * from "./constants";
export * from "./task-manager";
export * from "./task-interceptor";
export * from "./task-executor";

// 如果直接运行，启动插件服务器
if (import.meta.main) {
  const config = JSON.parse(process.env.PLUGIN_CONFIG || "{}");
  const debug = process.env.DEBUG_RESPONSES4CLAUDECODE === "1" || config.debug;

  console.log(`[responses4claudecode] Starting plugin server...`);

  createProxyServer({
    plugin: createResponses4ClaudeCodePlugin({ ...config, debug }),
  });
}
