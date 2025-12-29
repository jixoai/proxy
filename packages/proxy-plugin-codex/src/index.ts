#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-codex
 *
 * Codex 插件，实现 Codex Responses API ↔ Claude Messages API 转换：
 * - Request Hook: 将 Codex Responses API 请求转换为 Claude Messages API 请求
 * - Response Hook: 将 Claude Messages SSE 响应转换为 Codex Responses SSE 响应
 */

import { definePlugin } from "@jixo/proxy-plugin";
import { createCodexPlugin } from "./plugin";

// Plugin
export { createCodexPlugin, type CodexPluginOptions } from "./plugin";

// Request converter
export {
  isCodexRequest,
  mapModel,
  extractTargetModel,
  convertInstructions,
  buildSystemBlocks,
  convertReasoning,
  convertCallId,
  mergeInputToMessages,
  convertTools,
  convertRequest,
  convertHeaders,
  rewriteRequest,
  type SystemBlock,
  type ConvertRequestOptions,
  type RewriteRequestParams,
} from "./request-converter";

// Response converter
export {
  createConverterState,
  parseSSELine,
  processClaudeEvent,
  SSEStreamConverter,
  convertSSEResponse,
  // Error handling
  isContextLengthError,
  isUpstreamRequestFailedError,
  shouldConvertToContextLengthError,
  buildCodexContextLengthError,
  convertErrorResponse,
} from "./response-converter";

// Constants
export {
  TARGET_MODEL_HEADER,
  EFFORT_TO_BUDGET,
  DEFAULT_BUDGET_TOKENS,
  ANTHROPIC_BETA_FEATURES,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  DEFAULT_USER_ID,
  generateId,
} from "./constants";

// Types
export type {
  // Codex types
  CodexContentItem,
  CodexReasoningSummary,
  CodexReasoningContent,
  CodexResponseItem,
  CodexTool,
  CodexReasoning,
  CodexTextControls,
  CodexRequest,
  // Claude types
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeTool,
  ClaudeThinking,
  ClaudeRequest,
  // SSE types
  ClaudeSSEEvent,
  ClaudeSSEMessageStart,
  ClaudeSSEContentBlockStart,
  ClaudeSSEContentBlockDelta,
  ClaudeSSEContentBlockStop,
  ClaudeSSEMessageDelta,
  ClaudeSSEMessageStop,
  ClaudeSSEPing,
  ClaudeSSEError,
  // Converter
  ConverterState,
  ConvertResult,
} from "./types";

// 作为独立进程运行时启动服务器
if (import.meta.main) {
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  definePlugin(createCodexPlugin({ debug }), { debug });
}
