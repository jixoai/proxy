/**
 * 响应转换器
 *
 * 将 Gemini generateContent 响应转换为 Anthropic Messages API 响应
 */

import {
  isRecord,
  normalizeHeaders,
  isJsonContentType,
  isEventStreamContentType,
  safeParseJson,
} from "@jixo/proxy-plugin";
import type { ResponseMeta } from "@jixo/proxy-plugin";
import type {
  GeminiResponseBody,
  GeminiCandidate,
  GeminiPart,
  GeminiTextPart,
  GeminiFinishReason,
  GeminiErrorResponse,
  AnthropicResponseBody,
  AnthropicContentBlock,
  AnthropicStopReason,
  AnthropicErrorResponse,
  ResponseConversionResult,
} from "./types";

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 生成 tool_use ID
 */
function generateToolUseId(): string {
  return `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 工具名映射：Gemini -> Anthropic
 */
const TOOL_NAME_TO_ANTHROPIC: Record<string, string> = {
  google_web_search: "WebSearch",
};

/**
 * 转换 Gemini finish_reason 到 Anthropic stop_reason
 */
function convertFinishReason(
  finishReason: GeminiFinishReason | undefined
): AnthropicStopReason | null {
  if (!finishReason) return null;

  switch (finishReason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "OTHER":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/**
 * 检测响应是否包含 function_call (支持两种格式)
 */
function hasToolUse(candidate: GeminiCandidate): boolean {
  return candidate.content?.parts?.some((p) => 
    "function_call" in p || "functionCall" in p
  ) ?? false;
}

function getThoughtSignature(part: GeminiPart): string | undefined {
  return "thoughtSignature" in part && typeof part.thoughtSignature === "string"
    ? part.thoughtSignature
    : undefined;
}

/**
 * 转换 Gemini part 到 Anthropic content block
 */
function convertPart(part: GeminiPart): AnthropicContentBlock | null {
  const thoughtSignature = getThoughtSignature(part);

  // 处理 text (包括 thinking)
  if ("text" in part && part.text !== undefined) {
    const textPart = part as GeminiTextPart;
    
    // 如果是 thinking 内容，转换为 Anthropic thinking block
    if (textPart.thought) {
      return {
        type: "thinking",
        thinking: textPart.text,
        signature: "",
      };
    }
    
    // 如果有 thoughtSignature，说明这是 thinking 结束后的正常文本
    // thoughtSignature 本身不需要转换，只是标记
    
    return {
      type: "text",
      text: textPart.text,
      ...(thoughtSignature ? { gemini_thought_signature: thoughtSignature } : {}),
    };
  }

  // 处理 function_call (标准格式)
  if ("function_call" in part && part.function_call) {
    return {
      type: "tool_use",
      id: generateToolUseId(),
      name: TOOL_NAME_TO_ANTHROPIC[part.function_call.name] || part.function_call.name,
      input: part.function_call.args,
      ...(thoughtSignature ? { gemini_thought_signature: thoughtSignature } : {}),
    };
  }

  // 处理 functionCall (Gemini CLI 格式，camelCase)
  if ("functionCall" in part && part.functionCall) {
    return {
      type: "tool_use",
      id: generateToolUseId(),
      name: TOOL_NAME_TO_ANTHROPIC[part.functionCall.name] || part.functionCall.name,
      input: part.functionCall.args,
      ...(thoughtSignature ? { gemini_thought_signature: thoughtSignature } : {}),
    };
  }

  // inline_data (图片) 和 function_response 在响应中不常见，忽略
  return null;
}

/**
 * 转换 Gemini candidate 到 Anthropic content blocks
 */
function convertCandidate(candidate: GeminiCandidate): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  if (candidate.content?.parts) {
    for (const part of candidate.content.parts) {
      const block = convertPart(part);
      if (block) {
        blocks.push(block);
      }
    }
  }

  return blocks;
}

/**
 * 转换非流式 Gemini 响应到 Anthropic 格式
 */
export function convertResponse(
  geminiResponse: GeminiResponseBody,
  model: string = "gemini-2.5-pro"
): AnthropicResponseBody {
  const candidate = geminiResponse.candidates?.[0];
  const content = candidate ? convertCandidate(candidate) : [];
  const stopReason = hasToolUse(candidate!)
    ? "tool_use"
    : convertFinishReason(candidate?.finishReason);

  return {
    id: generateId(),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: geminiResponse.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount ?? 0,
      cache_read_input_tokens:
        geminiResponse.usageMetadata?.cachedContentTokenCount ?? 0,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * 转换 Gemini 错误响应到 Anthropic 错误格式
 */
export function convertErrorResponse(
  geminiError: GeminiErrorResponse
): AnthropicErrorResponse {
  const error = geminiError.error;

  // 映射常见的 Gemini 错误到 Anthropic 错误类型
  let errorType = "api_error";
  let errorCode: string | undefined;

  if (error.status === "INVALID_ARGUMENT") {
    errorType = "invalid_request_error";
  } else if (error.status === "RESOURCE_EXHAUSTED") {
    errorType = "rate_limit_error";
    errorCode = "rate_limit_exceeded";
  } else if (error.status === "PERMISSION_DENIED") {
    errorType = "authentication_error";
  } else if (error.status === "NOT_FOUND") {
    errorType = "not_found_error";
  } else if (
    error.message?.toLowerCase().includes("context") ||
    error.message?.toLowerCase().includes("token")
  ) {
    errorType = "invalid_request_error";
    errorCode = "context_length_exceeded";
  }

  return {
    type: "error",
    error: {
      type: errorType,
      code: errorCode,
      message: error.message,
    },
  };
}

// ============================================================================
// SSE 流式响应转换
// ============================================================================

/**
 * Anthropic SSE 事件类型
 */
/**
 * Anthropic SSE usage（在不同 event 中字段可能不完整；droid 侧会读取 input/cache 字段）
 */
type AnthropicSSEUsage = {
  output_tokens: number;
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type AnthropicSSEEvent =
  | { type: "message_start"; message: Partial<AnthropicResponseBody> }
  | {
      type: "content_block_start";
      index: number;
      content_block: AnthropicContentBlock;
    }
  | {
      type: "content_block_delta";
      index: number;
      delta: 
        | { type: "text_delta"; text: string } 
        | { type: "thinking_delta"; thinking: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: AnthropicStopReason | null; stop_sequence: string | null };
      usage: AnthropicSSEUsage;
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

/**
 * 流式响应转换器状态
 */
export interface StreamConverterState {
  messageId: string;
  model: string;
  contentBlockIndex: number;
  currentToolUseId: string | null;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** 当前工作目录，用于修复相对路径 */
  cwd: string | null;
  outputTokens: number;
  started: boolean;
  finished: boolean;
  /** 当前是否在 thinking block 中 */
  inThinkingBlock: boolean;
  /** 当前 block 类型 */
  currentBlockType: "text" | "thinking" | "tool_use" | null;
  /** 当前消息是否已经产生过工具调用 */
  hasToolUse: boolean;
}

/**
 * 创建流式转换器初始状态
 */
export function createStreamState(
  model: string = "gemini-2.5-pro",
  cwd: string | null = null,
): StreamConverterState {
  return {
    messageId: generateId(),
    model,
    contentBlockIndex: 0,
    currentToolUseId: null,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cwd,
    outputTokens: 0,
    started: false,
    finished: false,
    inThinkingBlock: false,
    currentBlockType: null,
    hasToolUse: false,
  };
}

/**
 * 格式化 SSE 事件 (Anthropic 格式：event: 和 data: 后无空格)
 */
function formatSSE(event: AnthropicSSEEvent): string {
  return `event:${event.type}\ndata:${JSON.stringify(event)}\n\n`;
}

/**
 * 生成 message_start 事件
 */
function generateMessageStart(state: StreamConverterState): string {
  const event: AnthropicSSEEvent = {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: state.inputTokens,
        cache_read_input_tokens: state.cacheReadInputTokens,
        cache_creation_input_tokens: state.cacheCreationInputTokens,
        output_tokens: 0,
      },
    },
  };
  return formatSSE(event);
}

/**
 * 生成 content_block_start 事件
 */
function generateContentBlockStart(
  index: number,
  block: AnthropicContentBlock
): string {
  const event: AnthropicSSEEvent = {
    type: "content_block_start",
    index,
    content_block: block,
  };
  return formatSSE(event);
}

/**
 * 生成 text delta 事件
 */
function generateTextDelta(index: number, text: string): string {
  const event: AnthropicSSEEvent = {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  };
  return formatSSE(event);
}

/**
 * 生成 thinking delta 事件
 */
function generateThinkingDelta(index: number, thinking: string): string {
  const event: AnthropicSSEEvent = {
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  };
  return formatSSE(event);
}

/**
 * 生成 input_json delta 事件 (tool_use)
 */
function generateInputJsonDelta(index: number, partialJson: string): string {
  const event: AnthropicSSEEvent = {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  };
  return formatSSE(event);
}

/**
 * 生成 content_block_stop 事件
 */
function generateContentBlockStop(index: number): string {
  const event: AnthropicSSEEvent = {
    type: "content_block_stop",
    index,
  };
  return formatSSE(event);
}

/**
 * 生成 message_delta 事件
 */
function generateMessageDelta(
  state: StreamConverterState,
  stopReason: AnthropicStopReason | null,
): string {
  const event: AnthropicSSEEvent = {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      input_tokens: state.inputTokens,
      cache_read_input_tokens: state.cacheReadInputTokens,
      cache_creation_input_tokens: state.cacheCreationInputTokens,
      output_tokens: state.outputTokens,
    },
  };
  return formatSSE(event);
}

/**
 * 生成 message_stop 事件
 */
function generateMessageStop(): string {
  const event: AnthropicSSEEvent = { type: "message_stop" };
  return formatSSE(event);
}

/**
 * 解析 Gemini SSE 行
 */
function parseGeminiSSELine(line: string): GeminiResponseBody | null {
  if (!line.startsWith("data:")) return null;

  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;

  try {
    return JSON.parse(data) as GeminiResponseBody;
  } catch {
    return null;
  }
}

function updateUsageFromGeminiChunk(
  geminiChunk: GeminiResponseBody,
  state: StreamConverterState
): void {
  const usage = geminiChunk.usageMetadata;
  if (!usage) return;

  if (typeof usage.promptTokenCount === "number") {
    state.inputTokens = usage.promptTokenCount;
  }
  if (typeof usage.candidatesTokenCount === "number") {
    state.outputTokens = usage.candidatesTokenCount;
  }
  if (typeof usage.cachedContentTokenCount === "number") {
    state.cacheReadInputTokens = usage.cachedContentTokenCount;
  }
}

/**
 * 已知需要路径参数的工具和对应的参数名
 */
const PATH_PARAMS: Record<string, string[]> = {
  LS: ["directory_path"],
  Read: ["file_path"],
  Create: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  Grep: ["path"],
  Glob: ["folder"],
  Execute: [], // Execute 的 command 参数中可能包含路径，但不好处理
};

/**
 * 常见参数名错误映射
 */
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  Read: { path: "file_path", filename: "file_path" },
  Create: { path: "file_path", filename: "file_path" },
  Edit: { path: "file_path", filename: "file_path" },
  LS: { path: "directory_path", dir: "directory_path" },
  Grep: { file_path: "path" },
};

/**
 * 修复工具参数：
 * 1. 修正参数名 (如 path -> file_path)
 * 2. 修复相对路径为绝对路径
 */
function fixToolArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
  cwd: string | null
): Record<string, unknown> | undefined {
  if (!args) return args;
  
  const fixedArgs = { ...args };
  
  // 1. 修正参数名
  const aliases = PARAM_ALIASES[toolName];
  if (aliases) {
    for (const [wrongName, correctName] of Object.entries(aliases)) {
      if (wrongName in fixedArgs && !(correctName in fixedArgs)) {
        fixedArgs[correctName] = fixedArgs[wrongName];
        delete fixedArgs[wrongName];
      }
    }
  }

  // 2. 修复相对路径
  if (cwd) {
    const pathParams = PATH_PARAMS[toolName];
    if (pathParams && pathParams.length > 0) {
      for (const paramName of pathParams) {
        const value = fixedArgs[paramName];
        if (typeof value === "string" && value && !value.startsWith("/")) {
          // 相对路径，转换为绝对路径
          fixedArgs[paramName] = `${cwd}/${value}`;
        }
      }
    }
  }
  
  return fixedArgs;
}

/**
 * 转换单个 Gemini SSE chunk 到 Anthropic SSE 事件
 */
export function convertStreamChunk(
  geminiChunk: GeminiResponseBody,
  state: StreamConverterState
): string {
  let output = "";

  // usageMetadata 可能只在最后一个 chunk 出现，但 droid 需要完整 token 信息
  updateUsageFromGeminiChunk(geminiChunk, state);

  // 首次收到数据时发送 message_start
  if (!state.started) {
    state.started = true;
    output += generateMessageStart(state);
  }

  const candidate = geminiChunk.candidates?.[0];
  if (!candidate?.content?.parts) return output;

  for (const part of candidate.content.parts) {
    const textPart = part as GeminiTextPart;
    const isThought = textPart.thought === true;
    const hasText = "text" in part && part.text !== undefined;

    // 处理 thinking (thought: true)
    if (isThought && hasText) {
      // 如果当前不在 thinking block，需要开始一个新的
      if (state.currentBlockType !== "thinking") {
        // 先关闭之前的 block（如果有）
        if (state.currentBlockType !== null) {
          output += generateContentBlockStop(state.contentBlockIndex);
          state.contentBlockIndex++;
        }
        // 开始 thinking block
        output += generateContentBlockStart(state.contentBlockIndex, {
          type: "thinking",
          thinking: "",
          signature: "",
        });
        state.currentBlockType = "thinking";
        state.inThinkingBlock = true;
      }
      // 发送 thinking delta
      if (textPart.text) {
        output += generateThinkingDelta(state.contentBlockIndex, textPart.text);
      }
      continue;
    }

    // 处理普通文本
    if (hasText && !isThought) {
      // 如果当前不在 text block，需要开始一个新的
      if (state.currentBlockType !== "text") {
        // 先关闭之前的 block（如果有）
        if (state.currentBlockType !== null) {
          output += generateContentBlockStop(state.contentBlockIndex);
          state.contentBlockIndex++;
        }
        // 开始 text block
        output += generateContentBlockStart(state.contentBlockIndex, {
          type: "text",
          text: "",
        });
        state.currentBlockType = "text";
        state.inThinkingBlock = false;
      }
      // 发送 text delta
      if (textPart.text) {
        output += generateTextDelta(state.contentBlockIndex, textPart.text);
      }
      continue;
    }

    // 处理 function_call (标准格式) 或 functionCall (Gemini CLI 格式)
    const funcCall = ("function_call" in part && part.function_call) 
      ? part.function_call 
      : ("functionCall" in part && part.functionCall) 
        ? part.functionCall 
        : null;
    
    if (funcCall) {
      state.hasToolUse = true;
      const thoughtSignature = getThoughtSignature(part);

      // 先关闭之前的 block（如果有）
      if (state.currentBlockType !== null) {
        output += generateContentBlockStop(state.contentBlockIndex);
        state.contentBlockIndex++;
      }

      const toolUseId = generateToolUseId();
      state.currentToolUseId = toolUseId;

      state.currentBlockType = "tool_use";

      // 工具名转换：Gemini -> Anthropic
      const anthropicToolName = TOOL_NAME_TO_ANTHROPIC[funcCall.name] || funcCall.name;

      // Anthropic 格式：start 中 input 为空，通过 delta 传输完整 JSON
      output += generateContentBlockStart(state.contentBlockIndex, {
        type: "tool_use",
        id: toolUseId,
        name: anthropicToolName,
        input: {},  // 空的，通过 delta 传
        ...(thoughtSignature ? { gemini_thought_signature: thoughtSignature } : {}),
      });
      
      // 修复工具参数（参数名修正 + 相对路径修复）
      const fixedArgs = fixToolArgs(
        anthropicToolName,
        funcCall.args as Record<string, unknown> | undefined,
        state.cwd
      );
      
      // Anthropic 格式：先发空的 partial_json，再发完整 JSON
      output += generateInputJsonDelta(state.contentBlockIndex, "");
      
      // 通过 input_json_delta 传输完整的 args JSON
      const argsJson = JSON.stringify(fixedArgs || {});
      output += generateInputJsonDelta(state.contentBlockIndex, argsJson);
      
      continue;
    }
  }

  // 检查是否完成
  if (candidate.finishReason) {
    state.finished = true;
    
    // 关闭最后一个 content block
    if (state.currentBlockType !== null) {
      output += generateContentBlockStop(state.contentBlockIndex);
    }
    
    const stopReason = state.hasToolUse || hasToolUse(candidate)
      ? "tool_use"
      : convertFinishReason(candidate.finishReason);

    output += generateMessageDelta(state, stopReason);
    output += generateMessageStop();
  }

  return output;
}

function extractUsageFromGeminiSSE(geminiSSE: string): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
} {
  const lines = geminiSSE.split("\n");
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;

  for (const line of lines) {
    const chunk = parseGeminiSSELine(line);
    if (!chunk?.usageMetadata) continue;

    const usage = chunk.usageMetadata;
    if (typeof usage.promptTokenCount === "number") inputTokens = usage.promptTokenCount;
    if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
    if (typeof usage.cachedContentTokenCount === "number") cacheReadInputTokens = usage.cachedContentTokenCount;
  }

  return { inputTokens, outputTokens, cacheReadInputTokens };
}

/**
 * 转换完整的 Gemini SSE 响应到 Anthropic SSE 格式
 */
export function convertStreamResponse(
  geminiSSE: string,
  model: string = "gemini-2.5-pro",
  cwd: string | null = null,
): string {
  // 由于插件侧拿到的是完整 body（非真流式透传），这里先预扫描一遍 usageMetadata，确保 message_start 能拿到 input/cache token
  const usage = extractUsageFromGeminiSSE(geminiSSE);
  const state = createStreamState(model, cwd);
  state.inputTokens = usage.inputTokens;
  state.outputTokens = usage.outputTokens;
  state.cacheReadInputTokens = usage.cacheReadInputTokens;
  let output = "";

  const lines = geminiSSE.split("\n");
  for (const line of lines) {
    const chunk = parseGeminiSSELine(line);
    if (chunk) {
      output += convertStreamChunk(chunk, state);
    }
  }

  // 如果没有正常结束，补充结束事件
  if (state.started && !state.finished) {
    // 仅当确实存在未关闭的 content block 时才补 stop，避免客户端出现 undefined content_block
    if (state.currentBlockType !== null) {
      output += generateContentBlockStop(state.contentBlockIndex);
    }
    output += generateMessageDelta(state, "end_turn");
    output += generateMessageStop();
  }

  return output;
}

// ============================================================================
// 主转换函数
// ============================================================================

/**
 * 检测是否为 Gemini 错误响应
 */
export function isGeminiError(parsed: unknown): parsed is GeminiErrorResponse {
  return isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string";
}

/**
 * 检测是否为 Gemini 成功响应
 */
export function isGeminiResponse(parsed: unknown): parsed is GeminiResponseBody {
  return isRecord(parsed) && (Array.isArray(parsed.candidates) || parsed.candidates === undefined);
}

/**
 * 判断响应是否看起来像 SSE
 */
export function looksLikeSSE(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  return head.startsWith("data:") || head.includes("\ndata:");
}

/**
 * 合并 SSE chunks 成完整的 Gemini 响应
 */
function mergeSSEChunks(text: string): GeminiResponseBody | null {
  const lines = text.split("\n");
  let merged: GeminiResponseBody | null = null;
  
  for (const line of lines) {
    const chunk = parseGeminiSSELine(line);
    if (!chunk) continue;
    
    if (!merged) {
      merged = chunk;
    } else {
      // 合并 candidates
      if (chunk.candidates?.[0]?.content?.parts) {
        if (!merged.candidates) {
          merged.candidates = chunk.candidates;
        } else if (merged.candidates[0]) {
          if (!merged.candidates[0].content) {
            merged.candidates[0].content = { role: "model", parts: [] };
          }
          merged.candidates[0].content.parts.push(...chunk.candidates[0].content.parts);
          // 更新 finishReason
          if (chunk.candidates[0].finishReason) {
            merged.candidates[0].finishReason = chunk.candidates[0].finishReason;
          }
          // 合并 groundingMetadata (包括 groundingChunks 和 groundingSupports)
          const chunkGrounding = (chunk.candidates[0] as unknown as {
            groundingMetadata?: { 
              groundingChunks?: unknown[];
              groundingSupports?: Array<{ 
                segment?: { text?: string };
                groundingChunkIndices?: number[];
              }>;
            };
          }).groundingMetadata;
          if (chunkGrounding) {
            const mergedCandidate = merged.candidates[0] as unknown as {
              groundingMetadata?: { 
                groundingChunks?: unknown[];
                groundingSupports?: Array<{ 
                  segment?: { text?: string };
                  groundingChunkIndices?: number[];
                }>;
              };
            };
            if (!mergedCandidate.groundingMetadata) {
              mergedCandidate.groundingMetadata = chunkGrounding;
            } else {
              // 计算当前的 chunk 偏移量
              const currentChunkOffset = mergedCandidate.groundingMetadata.groundingChunks?.length || 0;

              // 合并 groundingChunks
              if (chunkGrounding.groundingChunks) {
                mergedCandidate.groundingMetadata.groundingChunks = [
                  ...(mergedCandidate.groundingMetadata.groundingChunks || []),
                  ...chunkGrounding.groundingChunks,
                ];
              }
              // 合并 groundingSupports 并调整 indices
              if (chunkGrounding.groundingSupports) {
                const adjustedSupports = chunkGrounding.groundingSupports.map(support => ({
                  ...support,
                  groundingChunkIndices: support.groundingChunkIndices?.map(idx => idx + currentChunkOffset)
                }));
                
                mergedCandidate.groundingMetadata.groundingSupports = [
                  ...(mergedCandidate.groundingMetadata.groundingSupports || []),
                  ...adjustedSupports,
                ];
              }
            }
          }
        }
      }
      // 更新 usageMetadata
      if (chunk.usageMetadata) {
        merged.usageMetadata = chunk.usageMetadata;
      }
    }
  }
  
  return merged;
}

/**
 * 构建 websearch 响应（web_search_tool_result 格式）
 */
function buildWebSearchResponse(
  geminiResponse: GeminiResponseBody,
  model: string,
  searchQuery: string | null
): ResponseConversionResult {
  const candidate = geminiResponse.candidates?.[0];
  if (!candidate) {
    return { converted: false };
  }
  
  const parts = candidate.content?.parts ?? [];
  
  // 提取文本内容（跳过 thinking）
  let responseText = "";
  for (const part of parts) {
    const p = part as GeminiTextPart;
    if (typeof p.text === "string" && p.text && p.thought !== true) {
      responseText += p.text;
    }
  }
  
  // 尝试从 groundingMetadata 提取结果
  const groundingMetadata = (candidate as unknown as {
    groundingMetadata?: { 
      groundingChunks?: Array<{ web?: { uri?: string; title?: string; domain?: string } }>;
      groundingSupports?: Array<{ 
        segment?: { text?: string };
        groundingChunkIndices?: number[];
      }>;
    };
  }).groundingMetadata;
  
  const groundingChunks = groundingMetadata?.groundingChunks;
  const groundingSupports = groundingMetadata?.groundingSupports;
  
  // 构建 chunk 索引到支持文本的映射
  const chunkTextMap = new Map<number, string[]>();
  if (Array.isArray(groundingSupports)) {
    for (const support of groundingSupports) {
      const text = support.segment?.text;
      const indices = support.groundingChunkIndices;
      if (text && Array.isArray(indices)) {
        for (const idx of indices) {
          if (!chunkTextMap.has(idx)) {
            chunkTextMap.set(idx, []);
          }
          chunkTextMap.get(idx)!.push(text);
        }
      }
    }
  }
  
  const results: Array<{
    type: "web_search_result";
    title: string;
    url: string;
    encrypted_content: string;
    page_age: string | null;
    snippet: string;
    text: string;
  }> = [];
  
  if (Array.isArray(groundingChunks)) {
    for (let i = 0; i < groundingChunks.length; i++) {
      const chunk = groundingChunks[i];
      const web = chunk?.web;
      if (!web?.uri && !web?.title) continue;
      
      // 获取该 chunk 的支持文本作为 snippet
      const supportTexts = chunkTextMap.get(i) || [];
      const snippet = supportTexts.length > 0 
        ? supportTexts.join("\n\n")
        : (web.title || web.domain || "");
      
      results.push({
        type: "web_search_result",
        title: web.title || web.domain || "Result",
        url: web.uri || "",
        encrypted_content: Buffer.from(snippet.substring(0, 2000)).toString("base64"),
        page_age: null,
        snippet: snippet.substring(0, 500),
        text: snippet,
      });
    }
  }
  
  // 如果没有 grounding 结果，使用响应文本创建一个合成结果
  if (results.length === 0 && responseText) {
    results.push({
      type: "web_search_result",
      title: `Search results for: ${searchQuery || "query"}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(searchQuery || "")}`,
      encrypted_content: Buffer.from(responseText.substring(0, 2000)).toString("base64"),
      page_age: null,
      snippet: responseText.substring(0, 500),
      text: responseText,
    });
  }
  
  const msgId = `msg_ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const serverToolUseId = `srvtoolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  
  const webSearchResponse = {
    id: msgId,
    type: "message" as const,
    role: "assistant" as const,
    content: [
      {
        type: "server_tool_use" as const,
        id: serverToolUseId,
        name: "web_search",
        input: { query: searchQuery || "" },
      },
      {
        type: "web_search_tool_result" as const,
        tool_use_id: serverToolUseId,
        content: results,
      },
    ],
    model,
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: geminiResponse.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: geminiResponse.usageMetadata?.cachedContentTokenCount ?? 0,
      server_tool_use: {
        web_search_requests: 1,
      },
    },
  };
  
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: Buffer.from(JSON.stringify(webSearchResponse), "utf-8"),
    converted: true,
  };
}

/**
 * 重写响应
 */
export function rewriteResponse(params: {
  meta: ResponseMeta;
  body: Buffer;
  model?: string;
  cwd?: string | null;
  isWebSearch?: boolean;
  searchQuery?: string | null;
}): ResponseConversionResult {
  const { meta, body, model = "gemini-2.5-pro", cwd = null, isWebSearch = false, searchQuery = null } = params;
  const headers = normalizeHeaders(meta.headers) ?? {};
  const contentType = headers["content-type"];
  const text = body.toString("utf-8");

  if (!text.trim()) {
    return { converted: false };
  }

  // 检测是否为 SSE 流式响应
  if (isEventStreamContentType(contentType) || looksLikeSSE(text)) {
    // 如果是 websearch 请求，需要收集所有 SSE chunks 然后构建 web_search_tool_result 格式
    if (isWebSearch) {
      const mergedResponse = mergeSSEChunks(text);
      if (mergedResponse && isGeminiResponse(mergedResponse)) {
        return buildWebSearchResponse(mergedResponse, model, searchQuery);
      }
    }
    
    const anthropicSSE = convertStreamResponse(text, model, cwd);
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body: Buffer.from(anthropicSSE, "utf-8"),
      converted: true,
    };
  }

  // 尝试解析 JSON
  const parsed = safeParseJson(text);
  if (!parsed) {
    return { converted: false };
  }

  // 处理 websearch 响应：转换为 web_search_tool_result 格式
  if (isWebSearch && isGeminiResponse(parsed)) {
    return buildWebSearchResponse(parsed, model, searchQuery);
  }

  // 处理错误响应
  if (isGeminiError(parsed)) {
    const anthropicError = convertErrorResponse(parsed);
    return {
      statusCode: meta.statusCode ?? 400,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: Buffer.from(JSON.stringify(anthropicError), "utf-8"),
      converted: true,
    };
  }

  // 处理成功响应
  if (isGeminiResponse(parsed)) {
    const anthropicResponse = convertResponse(parsed, model);
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: Buffer.from(JSON.stringify(anthropicResponse), "utf-8"),
      converted: true,
    };
  }

  return { converted: false };
}
