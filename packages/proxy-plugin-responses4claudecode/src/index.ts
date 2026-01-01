#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-responses4claudecode
 *
 * Claude Messages API → OpenAI Responses API 转换插件
 *
 * 使用方式：
 * 1. 作为 CLI 运行: bunx @jixo/proxy-plugin-responses4claudecode
 * 2. 作为模块导入: import { createPlugin } from "@jixo/proxy-plugin-responses4claudecode"
 */

import { startPlugin, createPlugin } from "./plugin";

// 导出公共 API
export { startPlugin, createPlugin, createResponses4ClaudeCodePlugin, type Responses4ClaudeCodePluginOptions } from "./plugin";
export { isClaudeRequest, rewriteRequest, convertRequest } from "./request-converter";
export { SSEStreamConverter, convertSSEResponse, convertErrorResponse, convertSuccessResponse, isCodexSuccessResponse } from "./response-converter";
export * from "./types";
export * from "./constants";

// 如果直接运行，启动插件服务器
if (import.meta.main) {
  console.log(`[responses4claudecode] Starting plugin server...`);

  startPlugin()
    .then(() => {
      console.log(`[responses4claudecode] Ready to convert Claude Messages API → OpenAI Responses API`);
    })
    .catch((err) => {
      console.error(`[responses4claudecode] Failed to start:`, err);
      process.exit(1);
    });
}
