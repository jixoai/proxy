#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-claude-code
 *
 * Claude Messages API → Codex Responses API 转换插件
 *
 * 使用方式：
 * 1. 作为 CLI 运行: bunx @jixo/proxy-plugin-claude-code
 * 2. 作为模块导入: import { createPlugin } from "@jixo/proxy-plugin-claude-code"
 */

import { startPlugin, createPlugin } from "./plugin";

// 导出公共 API
export { startPlugin, createPlugin, createClaudeCodePlugin, type ClaudeCodePluginOptions } from "./plugin";
export { isClaudeRequest, rewriteRequest, convertRequest } from "./request-converter";
export { SSEStreamConverter, convertSSEResponse, convertErrorResponse, convertSuccessResponse, isCodexSuccessResponse } from "./response-converter";
export * from "./types";
export * from "./constants";

// 如果直接运行，启动插件服务器
if (import.meta.main) {
  console.log(`[claude-code] Starting plugin server...`);
  
  startPlugin()
    .then(() => {
      console.log(`[claude-code] Ready to convert Claude Messages API → Codex Responses API`);
    })
    .catch((err) => {
      console.error(`[claude-code] Failed to start:`, err);
      process.exit(1);
    });
}
