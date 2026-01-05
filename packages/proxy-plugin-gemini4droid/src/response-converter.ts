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
import { executeWebSearch } from "./web-search";

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

/**
 * 转换 Gemini part 到 Anthropic content block
 */
function convertPart(part: GeminiPart): AnthropicContentBlock | null {
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
    };
  }

  // 处理 function_call (标准格式)
  if ("function_call" in part && part.function_call) {
    return {
      type: "tool_use",
      id: generateToolUseId(),
      name: part.function_call.name,
      input: part.function_call.args,
    };
  }

  // 处理 functionCall (Gemini CLI 格式，camelCase)
  if ("functionCall" in part && part.functionCall) {
    return {
      type: "tool_use",
      id: generateToolUseId(),
      name: part.functionCall.name,
      input: part.functionCall.args,
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
      usage: { output_tokens: number };
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
  /** 当前工作目录，用于修复相对路径 */
  cwd: string | null;
  /** API Key（用于 web search） */
  apiKey: string | null;
  /** 上游 base URL（用于 web search） */
  upstreamUrl: string | null;
  outputTokens: number;
  started: boolean;
  finished: boolean;
  /** 当前是否在 thinking block 中 */
  inThinkingBlock: boolean;
  /** 当前 block 类型 */
  currentBlockType: "text" | "thinking" | "tool_use" | null;
  /** 是否执行了 server tool（如 websearch），用于决定 stop_reason */
  hasServerToolUse: boolean;
}

/**
 * 创建流式转换器初始状态
 */
export function createStreamState(
  model: string = "gemini-2.5-pro",
  cwd: string | null = null,
  apiKey: string | null = null,
  upstreamUrl: string | null = null
): StreamConverterState {
  return {
    messageId: generateId(),
    model,
    contentBlockIndex: 0,
    currentToolUseId: null,
    inputTokens: 0,
    cwd,
    apiKey,
    upstreamUrl,
    outputTokens: 0,
    started: false,
    finished: false,
    inThinkingBlock: false,
    currentBlockType: null,
    hasServerToolUse: false,
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
  stopReason: AnthropicStopReason | null,
  outputTokens: number
): string {
  const event: AnthropicSSEEvent = {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
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
 * 修复工具调用中的相对路径为绝对路径
 */
function fixRelativePaths(
  toolName: string,
  args: Record<string, unknown> | undefined,
  cwd: string | null
): Record<string, unknown> | undefined {
  if (!args || !cwd) return args;
  
  const pathParams = PATH_PARAMS[toolName];
  if (!pathParams || pathParams.length === 0) return args;
  
  const fixedArgs = { ...args };
  
  for (const paramName of pathParams) {
    const value = fixedArgs[paramName];
    if (typeof value === "string" && value && !value.startsWith("/")) {
      // 相对路径，转换为绝对路径
      fixedArgs[paramName] = `${cwd}/${value}`;
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

  // 首次收到数据时发送 message_start
  if (!state.started) {
    state.started = true;
    if (geminiChunk.usageMetadata?.promptTokenCount) {
      state.inputTokens = geminiChunk.usageMetadata.promptTokenCount;
    }
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
      // 先关闭之前的 block（如果有）
      if (state.currentBlockType !== null) {
        output += generateContentBlockStop(state.contentBlockIndex);
        state.contentBlockIndex++;
      }

      const toolUseId = generateToolUseId();
      state.currentToolUseId = toolUseId;

      // 特殊处理 google_web_search：执行搜索，返回 text 结果
      // 注意：Droid 的 websearch UI 只在非流式模式下工作
      // 在流式模式下，我们直接返回搜索结果作为 text
      if (funcCall.name === "google_web_search" && state.apiKey && state.upstreamUrl) {
        const query = (funcCall.args as { query?: string })?.query || "";
        
        // 执行搜索
        const searchResponse = executeWebSearch(query, state.apiKey, state.upstreamUrl);
        
        // 返回搜索结果作为 text block
        output += generateContentBlockStart(state.contentBlockIndex, {
          type: "text",
          text: "",
        });
        output += generateTextDelta(state.contentBlockIndex, searchResponse.responseText);
        output += generateContentBlockStop(state.contentBlockIndex);
        state.contentBlockIndex++;
        
        state.currentBlockType = null;
        state.hasServerToolUse = true; // stop_reason: end_turn
        continue;
      }

      state.currentBlockType = "tool_use";

      // 工具名转换：Gemini -> Anthropic
      const TOOL_NAME_TO_ANTHROPIC: Record<string, string> = {
        google_web_search: "WebSearch",
      };
      const anthropicToolName = TOOL_NAME_TO_ANTHROPIC[funcCall.name] || funcCall.name;

      // Anthropic 格式：start 中 input 为空，通过 delta 传输完整 JSON
      output += generateContentBlockStart(state.contentBlockIndex, {
        type: "tool_use",
        id: toolUseId,
        name: anthropicToolName,
        input: {},  // 空的，通过 delta 传
      });
      
      // 修复相对路径为绝对路径
      const fixedArgs = fixRelativePaths(
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
    
    // 更新 token 计数 (使用 camelCase)
    if (geminiChunk.usageMetadata?.candidatesTokenCount) {
      state.outputTokens = geminiChunk.usageMetadata.candidatesTokenCount;
    }

    // 如果是 server tool（websearch），stop_reason 应为 end_turn
    // 否则检查是否有普通 tool_use
    const stopReason = state.hasServerToolUse
      ? "end_turn"
      : hasToolUse(candidate)
        ? "tool_use"
        : convertFinishReason(candidate.finishReason);

    output += generateMessageDelta(stopReason, state.outputTokens);
    output += generateMessageStop();
  }

  return output;
}

/**
 * 转换完整的 Gemini SSE 响应到 Anthropic SSE 格式
 */
export function convertStreamResponse(
  geminiSSE: string,
  model: string = "gemini-2.5-pro",
  cwd: string | null = null,
  apiKey: string | null = null,
  upstreamUrl: string | null = null
): string {
  const state = createStreamState(model, cwd, apiKey, upstreamUrl);
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
    output += generateContentBlockStop(state.contentBlockIndex);
    output += generateMessageDelta("end_turn", state.outputTokens);
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
 * 重写响应
 */
export function rewriteResponse(params: {
  meta: ResponseMeta;
  body: Buffer;
  model?: string;
  cwd?: string | null;
  apiKey?: string | null;
  upstreamUrl?: string | null;
}): ResponseConversionResult {
  const { meta, body, model = "gemini-2.5-pro", cwd = null, apiKey = null, upstreamUrl = null } = params;
  const headers = normalizeHeaders(meta.headers) ?? {};
  const contentType = headers["content-type"];
  const text = body.toString("utf-8");

  if (!text.trim()) {
    return { converted: false };
  }

  // 检测是否为 SSE 流式响应
  if (isEventStreamContentType(contentType) || looksLikeSSE(text)) {
    const anthropicSSE = convertStreamResponse(text, model, cwd, apiKey, upstreamUrl);
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
