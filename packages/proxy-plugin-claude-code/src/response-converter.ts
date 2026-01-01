/**
 * Codex Responses SSE → Claude Messages SSE 响应转换器
 */

import type {
  CodexSSEEvent,
  CodexSSEResponseCreated,
  CodexSSEOutputItemAdded,
  CodexSSEContentPartAdded,
  CodexSSEOutputTextDelta,
  CodexSSEOutputTextDone,
  CodexSSEReasoningSummaryDelta,
  CodexSSEReasoningSummaryDone,
  CodexSSEFunctionCallArgumentsDelta,
  CodexSSEFunctionCallArgumentsDone,
  CodexSSEOutputItemDone,
  CodexSSEContentPartDone,
  CodexSSEAnnotationAdded,
  CodexSSEResponseCompleted,
  CodexSSEError,
  ConverterState,
  UrlCitation,
  WebSearchCallState,
} from "./types";

import {
  convertResponseIdToMessageId,
  convertCallIdToToolId,
  isCustomTool,
  mapToolNameToClaude,
} from "./constants";

/**
 * 创建初始转换器状态
 */
export function createConverterState(): ConverterState {
  return {
    messageId: "",
    model: "",
    contentBlockIndex: 0,
    currentBlockType: null,
    currentItemId: "",
    currentToolId: "",
    currentToolName: "",
    toolInputJson: "",
    textContent: "",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    messageStarted: false,
    blockStarted: false,
    createdAt: Math.floor(Date.now() / 1000),
    webSearchCalls: [],
    activeWebSearchItemId: "",
    urlCitations: [],
    hasToolUse: false,
    pendingFunctionCalls: new Map(),
    streamCompleted: false,
  };
}

/**
 * 格式化 SSE 事件
 * 注意：使用 "event:xxx" 格式（无空格），与原生 Claude 响应保持一致
 */
function formatSSE(eventType: string, data: unknown): string {
  return `event:${eventType}\ndata:${JSON.stringify(data)}\n\n`;
}

/**
 * 处理 response.created 事件
 */
function handleResponseCreated(
  state: ConverterState,
  event: CodexSSEResponseCreated
): string[] {
  const response = event.response;
  state.messageId = convertResponseIdToMessageId(response.id);
  state.model = response.model;
  state.messageStarted = true;
  
  const messageStart = {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: state.usage.inputTokens,
        output_tokens: state.usage.outputTokens,
        cache_creation_input_tokens: state.usage.cacheCreationTokens,
        cache_read_input_tokens: state.usage.cacheReadTokens,
      },
    },
  };
  
  return [formatSSE("message_start", messageStart)];
}

/**
 * 结束当前的 content block（如果有）
 */
function finishCurrentBlock(state: ConverterState): string[] {
  if (!state.blockStarted || state.currentBlockType === null) {
    return [];
  }
  
  const events: string[] = [];
  const blockIndex = state.contentBlockIndex;
  
  // 发送 content_block_stop
  events.push(formatSSE("content_block_stop", {
    type: "content_block_stop",
    index: blockIndex,
  }));
  
  // 重置状态
  state.blockStarted = false;
  state.currentBlockType = null;
  state.contentBlockIndex++;
  
  return events;
}

/**
 * 生成服务端工具使用 ID
 */
function generateServerToolUseId(): string {
  return `srvtoolu_${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * 处理 response.output_item.added 事件
 */
function handleOutputItemAdded(
  state: ConverterState,
  event: CodexSSEOutputItemAdded
): string[] {
  const events: string[] = [];
  const item = event.item;

  switch (item.type) {
    case "function_call":
    case "custom_tool_call": {
      // 开始 tool_use block
      events.push(...finishCurrentBlock(state));
      state.currentItemId = item.id;
      // 开始 tool_use block
      state.currentBlockType = "tool_use";
      state.currentToolId = convertCallIdToToolId(item.call_id || "");
      // 映射工具名称（如 update_plan → TodoWrite）
      state.currentToolName = mapToolNameToClaude(item.name || "");
      state.toolInputJson = "";
      state.blockStarted = true;
      state.hasToolUse = true;  // 标记有工具调用

      events.push(formatSSE("content_block_start", {
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "tool_use",
          id: state.currentToolId,
          name: state.currentToolName,
          input: {},
        },
      }));

      // Claude 在 tool_use 开始后会先发送一个空的 input_json_delta
      events.push(formatSSE("content_block_delta", {
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: "",
        },
      }));
      break;
    }

    case "web_search_call": {
      // 处理 web_search_call - 转换为 Claude 的 server_tool_use
      events.push(...finishCurrentBlock(state));
      state.currentItemId = item.id;
      state.currentBlockType = "server_tool_use";
      state.blockStarted = true;

      // 创建新的 web_search_call 状态
      const toolUseId = generateServerToolUseId();
      const action = item.action;
      const query = (action?.type === "search" && action.query) ? action.query : "";

      const webSearchState: WebSearchCallState = {
        itemId: item.id,
        toolUseId,
        query,
        citations: [],
        resultSent: false,
      };
      state.webSearchCalls.push(webSearchState);
      state.activeWebSearchItemId = item.id;

      // 发送 server_tool_use 块开始
      events.push(formatSSE("content_block_start", {
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "server_tool_use",
          id: toolUseId,
          name: "web_search",
          input: query ? { query } : {},
        },
      }));
      break;
    }

    // Ignore other non-executable items (e.g. reasoning, compaction).
    default:
      break;
  }

  return events;
}

/**
 * 处理 response.content_part.added 事件
 */
function handleContentPartAdded(
  state: ConverterState,
  event: CodexSSEContentPartAdded
): string[] {
  const events: string[] = [];
  const part = event.part;
  
  // 如果是 output_text 类型，开始 text block
  if (part.type === "output_text" && state.currentBlockType !== "text") {
    // 先结束之前的 block
    events.push(...finishCurrentBlock(state));
    
    state.currentBlockType = "text";
    state.currentItemId = event.item_id;
    state.textContent = "";
    state.blockStarted = true;
    
    events.push(formatSSE("content_block_start", {
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: {
        type: "text",
        text: "",
      },
    }));
  }
  
  return events;
}

/**
 * 处理 response.output_text.delta 事件
 */
function handleOutputTextDelta(
  state: ConverterState,
  event: CodexSSEOutputTextDelta
): string[] {
  const events: string[] = [];
  
  // 确保 text block 已开始
  if (state.currentBlockType !== "text") {
    // 先结束之前的 block
    events.push(...finishCurrentBlock(state));
    
    state.currentBlockType = "text";
    state.currentItemId = event.item_id;
    state.textContent = "";
    state.blockStarted = true;
    
    events.push(formatSSE("content_block_start", {
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: {
        type: "text",
        text: "",
      },
    }));
  }
  
  state.textContent += event.delta;
  
  events.push(formatSSE("content_block_delta", {
    type: "content_block_delta",
    index: state.contentBlockIndex,
    delta: {
      type: "text_delta",
      text: event.delta,
    },
  }));
  
  return events;
}

/**
 * 处理 response.reasoning_summary.delta 事件
 */
function handleReasoningSummaryDelta(
  state: ConverterState,
  event: CodexSSEReasoningSummaryDelta
): string[] {
  void state;
  void event;
  // Claude "thinking" blocks require verifiable signatures in multi-turn conversations.
  // Codex "reasoning" is not Claude-compatible, so we drop it to keep responses readable
  // and avoid signature/encrypted-content mismatches.
  return [];
}

/**
 * 处理 response.function_call_arguments.delta 事件
 */
function handleFunctionCallArgumentsDelta(
  state: ConverterState,
  event: CodexSSEFunctionCallArgumentsDelta
): string[] {
  const events: string[] = [];

  // 如果 tool_use block 已开始，正常处理
  if (state.currentBlockType === "tool_use") {
    state.toolInputJson += event.delta;

    events.push(formatSSE("content_block_delta", {
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: event.delta,
      },
    }));

    return events;
  }

  // tool_use block 尚未开始（可能缺少 output_item.added 事件）
  // 将参数缓冲到 pendingFunctionCalls，等待 output_item.done 事件获取函数名
  const itemId = event.item_id;
  const pending = state.pendingFunctionCalls.get(itemId);
  if (pending) {
    pending.arguments += event.delta;
  } else {
    state.pendingFunctionCalls.set(itemId, {
      outputIndex: event.output_index,
      arguments: event.delta,
    });
  }

  return events;
}

/**
 * 处理 response.output_item.done 事件
 */
function handleOutputItemDone(
  state: ConverterState,
  event: CodexSSEOutputItemDone
): string[] {
  const events: string[] = [];
  const item = event.item;

  // 处理 web_search_call 完成
  if (item.type === "web_search_call" && state.currentBlockType === "server_tool_use") {
    // 更新查询信息（如果有）
    const webSearchState = state.webSearchCalls.find(ws => ws.itemId === item.id);
    if (webSearchState && item.action?.type === "search" && item.action.query) {
      webSearchState.query = item.action.query;
    }

    // 结束 server_tool_use 块
    events.push(...finishCurrentBlock(state));
    // 注意：web_search_tool_result 将在 response.completed 时发送
    // 因为 url_citation 事件可能在 output_item.done 之后才到达
    return events;
  }

  // 处理 function_call 完成 - 检查是否有缓冲的参数数据
  if ((item.type === "function_call" || item.type === "custom_tool_call") && state.pendingFunctionCalls.has(item.id)) {
    const pending = state.pendingFunctionCalls.get(item.id)!;
    state.pendingFunctionCalls.delete(item.id);

    // 先结束之前的 block（如果有）
    events.push(...finishCurrentBlock(state));

    // 现在我们有了完整的函数信息，发送完整的 tool_use 块
    const toolId = convertCallIdToToolId(item.call_id || item.id);
    const toolName = mapToolNameToClaude(item.name || "unknown");
    const inputJson = pending.arguments;

    state.hasToolUse = true;

    // 发送 content_block_start
    events.push(formatSSE("content_block_start", {
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: {
        type: "tool_use",
        id: toolId,
        name: toolName,
        input: {},
      },
    }));

    // 发送完整的 input JSON（作为单个 delta）
    events.push(formatSSE("content_block_delta", {
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: inputJson,
      },
    }));

    // 发送 content_block_stop
    events.push(formatSSE("content_block_stop", {
      type: "content_block_stop",
      index: state.contentBlockIndex,
    }));

    state.contentBlockIndex++;
    return events;
  }

  // 如果当前有 block 在进行中，结束它
  if (state.blockStarted && state.currentItemId === item.id) {
    events.push(...finishCurrentBlock(state));
  }

  return events;
}

/**
 * 处理 response.content_part.done 事件
 */
function handleContentPartDone(
  state: ConverterState,
  event: CodexSSEContentPartDone
): string[] {
  // 通常在 output_item.done 时处理，这里不做额外操作
  return [];
}

/**
 * 处理 response.output_text.annotation.added 事件
 * 收集 url_citation 用于生成 web_search_tool_result
 */
function handleAnnotationAdded(
  state: ConverterState,
  event: CodexSSEAnnotationAdded
): string[] {
  const annotation = event.annotation;

  // 只处理 url_citation 类型
  if (annotation.type === "url_citation" && annotation.url) {
    const citation: UrlCitation = {
      url: annotation.url,
      title: annotation.title || annotation.url,
    };

    // 兜底：记录所有引用（Codex 并不保证能将引用与具体 web_search_call 一一对应）
    state.urlCitations.push(citation);

    // 最佳努力：把引用归属到“当前活跃的” web_search_call（按出现顺序）
    const active = state.webSearchCalls.find((ws) => ws.itemId === state.activeWebSearchItemId);
    if (active) {
      active.citations.push(citation);
    }
  }

  return [];
}

/**
 * 处理 response.completed 事件
 */
function handleResponseCompleted(
  state: ConverterState,
  event: CodexSSEResponseCompleted
): string[] {
  const events: string[] = [];
  const response = event.response;

  // 标记流正常完成
  state.streamCompleted = true;

  // 结束当前 block
  events.push(...finishCurrentBlock(state));

  // 处理待处理的函数调用（当 delta 事件先于 output_item.done 到达，或没有 output_item.done 时）
  // 从 response.output 中获取函数名称信息
  if (state.pendingFunctionCalls.size > 0 && Array.isArray(response.output)) {
    for (const outputItem of response.output) {
      const item = outputItem as { id?: string; type?: string; name?: string; call_id?: string; arguments?: string };
      if ((item.type === "function_call" || item.type === "custom_tool_call") && item.id && state.pendingFunctionCalls.has(item.id)) {
        const pending = state.pendingFunctionCalls.get(item.id)!;
        state.pendingFunctionCalls.delete(item.id);

        const toolId = convertCallIdToToolId(item.call_id || item.id);
        const toolName = mapToolNameToClaude(item.name || "unknown");
        // 优先使用缓冲的参数，如果没有则使用 output 中的参数
        const inputJson = pending.arguments || item.arguments || "{}";

        state.hasToolUse = true;

        // 发送 content_block_start
        events.push(formatSSE("content_block_start", {
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolId,
            name: toolName,
            input: {},
          },
        }));

        // 发送完整的 input JSON
        events.push(formatSSE("content_block_delta", {
          type: "content_block_delta",
          index: state.contentBlockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: inputJson,
          },
        }));

        // 发送 content_block_stop
        events.push(formatSSE("content_block_stop", {
          type: "content_block_stop",
          index: state.contentBlockIndex,
        }));

        state.contentBlockIndex++;
      }
    }
  }

  // 检查是否有未发送结果的 web_search_call
  // Codex API 不会将 url_citation 与特定的 web_search_call 关联
  // 所有引用都是最终文本输出的注释，因此我们尽最大努力按“活跃搜索”归属，
  // 并确保每个 web_search_call 都会收到对应的 web_search_tool_result。
  const unsentWebSearches = state.webSearchCalls.filter(ws => !ws.resultSent);
  if (unsentWebSearches.length > 0) {
    const fallbackResults = state.urlCitations.map(citation => ({
      type: "web_search_result" as const,
      url: citation.url,
      title: citation.title,
      encrypted_content: "",
      page_age: undefined,
    }));

    for (const ws of unsentWebSearches) {
      const scoped = ws.citations.length > 0 ? ws.citations : state.urlCitations;
      const results = scoped.map(citation => ({
        type: "web_search_result" as const,
        url: citation.url,
        title: citation.title,
        encrypted_content: "",
        page_age: undefined,
      }));

      events.push(formatSSE("content_block_start", {
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: ws.toolUseId,
          content: results.length > 0 ? results : fallbackResults,
        },
      }));

      events.push(formatSSE("content_block_stop", {
        type: "content_block_stop",
        index: state.contentBlockIndex,
      }));
      state.contentBlockIndex++;

      ws.resultSent = true;
    }

    // 清空已使用的引用（该 state 生命周期仅覆盖单次响应）
    state.urlCitations = [];
  }

  // 更新 usage
  if (response.usage) {
    state.usage.inputTokens = response.usage.input_tokens || 0;
    state.usage.outputTokens = response.usage.output_tokens || 0;
  }

  // 根据是否有工具调用确定 stop_reason
  // Claude 在调用工具时使用 "tool_use"，否则使用 "end_turn"
  const stopReason = state.hasToolUse ? "tool_use" : "end_turn";

  // 发送 message_delta
  // 添加 context_management 字段以匹配 Claude API 格式
  events.push(formatSSE("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      input_tokens: state.usage.inputTokens,
      output_tokens: state.usage.outputTokens,
      cache_creation_input_tokens: state.usage.cacheCreationTokens,
      cache_read_input_tokens: state.usage.cacheReadTokens,
    },
    context_management: {
      applied_edits: [],
    },
  }));

  // 发送 message_stop
  events.push(formatSSE("message_stop", {
    type: "message_stop",
  }));

  return events;
}

/**
 * 处理 error 事件
 */
function handleError(
  state: ConverterState,
  event: CodexSSEError
): string[] {
  const events: string[] = [];

  // Some gateways emit SSE errors in a flattened shape:
  // {"type":"error","code":"server_error","message":"...","sequence_number":0}
  // instead of the OpenAI-style {"type":"error","error":{...}}.
  const nested = (event as unknown as { error?: { type?: string; code?: string; message?: string } }).error;
  const flat = event as unknown as { code?: string; message?: string; type?: string };

  const errorType =
    nested?.type ||
    nested?.code ||
    flat.code ||
    (typeof flat.type === "string" ? flat.type : undefined) ||
    "api_error";

  const message = nested?.message || flat.message || "Unknown error";

  // 检测上下文窗口超限错误
  // 当检测到这类错误时，我们需要返回一个较大的 input_tokens 值
  // 以便 Claude Code 知道上下文过大，需要触发摘要压缩
  const isContextWindowError = message.toLowerCase().includes("context window") ||
    message.toLowerCase().includes("context length") ||
    message.toLowerCase().includes("input exceeds") ||
    message.toLowerCase().includes("too many tokens") ||
    message.toLowerCase().includes("token limit");

  if (isContextWindowError) {
    // 设置一个较大的 input_tokens 值来表示上下文过大
    // 使用 200000 作为默认值，这应该足以触发 Claude Code 的摘要机制
    state.usage.inputTokens = 200000;
  }

  // 发送 error 事件
  events.push(formatSSE("error", {
    type: "error",
    error: {
      type: errorType,
      message,
    },
  }));

  // 发送 message_delta 包含 usage 信息
  // 这对于 Claude Code 判断上下文大小非常重要
  events.push(formatSSE("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: "error",
      stop_sequence: null,
    },
    usage: {
      input_tokens: state.usage.inputTokens,
      output_tokens: state.usage.outputTokens,
      cache_creation_input_tokens: state.usage.cacheCreationTokens,
      cache_read_input_tokens: state.usage.cacheReadTokens,
    },
  }));

  // 发送 message_stop 以正确关闭流
  events.push(formatSSE("message_stop", {
    type: "message_stop",
  }));

  return events;
}

/**
 * 处理单个 Codex SSE 事件
 */
export function processCodexEvent(
  state: ConverterState,
  eventType: string,
  eventData: CodexSSEEvent
): string[] {
  // 调试日志：记录所有事件
  if (process.env.DEBUG_CODEX_EVENTS === "1") {
    console.log(`[Codex Event] ${eventType}:`, JSON.stringify(eventData).slice(0, 500));
  }

  switch (eventType) {
    case "response.created":
      return handleResponseCreated(state, eventData as CodexSSEResponseCreated);

    case "response.in_progress":
      // 忽略
      return [];

    case "response.output_item.added":
      return handleOutputItemAdded(state, eventData as CodexSSEOutputItemAdded);

    case "response.content_part.added":
      return handleContentPartAdded(state, eventData as CodexSSEContentPartAdded);

    case "response.output_text.delta":
      return handleOutputTextDelta(state, eventData as CodexSSEOutputTextDelta);

    case "response.output_text.done":
      // 通常在 output_item.done 时处理
      return [];

    case "response.reasoning_summary.delta":
      return handleReasoningSummaryDelta(state, eventData as CodexSSEReasoningSummaryDelta);

    case "response.reasoning_summary.done":
      // 通常在 output_item.done 时处理
      return [];

    case "response.function_call_arguments.delta":
      return handleFunctionCallArgumentsDelta(state, eventData as CodexSSEFunctionCallArgumentsDelta);

    case "response.function_call_arguments.done":
      // 通常在 output_item.done 时处理
      return [];

    case "response.output_item.done":
      return handleOutputItemDone(state, eventData as CodexSSEOutputItemDone);

    case "response.content_part.done":
      return handleContentPartDone(state, eventData as CodexSSEContentPartDone);

    case "response.completed":
      return handleResponseCompleted(state, eventData as CodexSSEResponseCompleted);

    case "error":
      return handleError(state, eventData as CodexSSEError);

    // Web search 相关事件 - 这些事件在搜索过程中触发
    case "response.web_search_call.in_progress":
    case "response.web_search_call.searching":
      // 搜索进行中，可以发送 ping 保持连接
      return [];

    case "response.web_search_call.completed":
      // 搜索完成，结果通常在 output_item.done 中处理
      return [];

    case "response.output_text.annotation.added":
      return handleAnnotationAdded(state, eventData as CodexSSEAnnotationAdded);

    default:
      return [];
  }
}

/**
 * SSE 流转换器类
 */
export class SSEStreamConverter {
  private state: ConverterState;
  private buffer: string = "";
  private currentEvent: string = "";
  
  constructor() {
    this.state = createConverterState();
  }
  
  /**
   * 处理 SSE 数据块
   */
  processChunk(chunk: string): string {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    
    let output = "";
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed === "") {
        continue;
      }
      
      if (trimmed.startsWith("event:")) {
        this.currentEvent = trimmed.slice(6).trim();
        continue;
      }
      
      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          continue;
        }
        
        try {
          const data = JSON.parse(dataStr) as CodexSSEEvent;
          const eventType = this.currentEvent || (data as { type?: string }).type || "";
          const events = processCodexEvent(this.state, eventType, data);
          output += events.join("");
        } catch {
          // 忽略解析错误
        }
        
        this.currentEvent = "";
      }
    }
    
    return output;
  }
  
  /**
   * 完成转换，处理剩余缓冲
   * 如果流没有正常完成（没有收到 response.completed），会生成一个中断结束事件
   */
  finish(): string {
    let result = "";

    // 处理剩余缓冲
    if (this.buffer.trim()) {
      result += this.processChunk("\n");
    }

    // 如果流没有正常完成，需要生成中断结束事件
    if (!this.state.streamCompleted && this.state.messageStarted) {
      const events: string[] = [];

      // 结束当前 block（如果有）
      events.push(...finishCurrentBlock(this.state));

      // 根据是否有工具调用确定 stop_reason
      // 与 handleResponseCompleted 保持一致的逻辑
      const stopReason = this.state.hasToolUse ? "tool_use" : "end_turn";

      // 发送 message_delta（包含 stop_reason 和 usage）
      events.push(formatSSE("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage: {
          input_tokens: this.state.usage.inputTokens,
          output_tokens: this.state.usage.outputTokens,
          cache_creation_input_tokens: this.state.usage.cacheCreationTokens,
          cache_read_input_tokens: this.state.usage.cacheReadTokens,
        },
      }));

      // 发送 message_stop
      events.push(formatSSE("message_stop", {
        type: "message_stop",
      }));

      result += events.join("");
    }

    return result;
  }
  
  /**
   * 获取当前状态
   */
  getState(): ConverterState {
    return this.state;
  }
}

/**
 * 转换完整的 SSE 响应体
 */
export function convertSSEResponse(codexSSE: string): string {
  const converter = new SSEStreamConverter();
  let result = converter.processChunk(codexSSE);
  result += converter.finish();
  return result;
}

// ============================================================================
// 错误响应处理 (非 SSE 格式)
// ============================================================================

/**
 * 检测是否为 Codex/OpenAI 错误响应
 *
 * 支持两种格式：
 * 1. Codex 格式: { type: "error", error: {...} }
 * 2. 标准 OpenAI 格式: { error: {...} }（没有顶层 type）
 */
export function isCodexErrorResponse(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const err = body as { type?: string; error?: unknown };

  // 格式1: { type: "error", error: {...} }
  if (err.type === "error" && !!err.error) return true;

  // 格式2: { error: {...} }（标准 OpenAI 格式，没有顶层 type）
  // 确保 error 是对象且包含 message 或 type 或 code
  if (!err.type && err.error && typeof err.error === "object") {
    const errorObj = err.error as { message?: string; type?: string; code?: string };
    return !!(errorObj.message || errorObj.type || errorObj.code);
  }

  return false;
}

/**
 * 转换 Codex/OpenAI 错误响应为 Claude 格式
 *
 * 输入格式：
 * - { type: "error", error: { type, code, message } }
 * - { error: { type, code, message } }
 *
 * 输出格式：
 * - { type: "error", error: { type, message } }
 */
export function convertErrorResponse(codexError: unknown): object | null {
  if (!isCodexErrorResponse(codexError)) {
    return null;
  }

  const err = codexError as {
    type?: string;
    error: { type?: string; code?: string; message?: string };
  };

  return {
    type: "error",
    error: {
      type: err.error.type || err.error.code || "api_error",
      message: err.error.message || "Unknown error",
    },
  };
}

// ============================================================================
// 非流式成功响应处理 (stream: false)
// ============================================================================

/**
 * 检测是否为 Codex 成功响应（非流式）
 *
 * Codex 成功响应格式：
 * {
 *   id: "resp_xxx",
 *   object: "response",
 *   status: "completed",
 *   output: [...],
 *   usage: {...}
 * }
 */
export function isCodexSuccessResponse(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const resp = body as {
    object?: string;
    status?: string;
    output?: unknown[];
  };
  return (
    resp.object === "response" &&
    (resp.status === "completed" || resp.status === "in_progress") &&
    Array.isArray(resp.output)
  );
}

/**
 * 转换 Codex 非流式成功响应为 Claude 格式
 *
 * 输入 (Codex Responses API):
 * {
 *   id: "resp_xxx",
 *   object: "response",
 *   status: "completed",
 *   model: "gpt-5.2",
 *   output: [
 *     { type: "message", role: "assistant", content: [{ type: "output_text", text: "..." }] }
 *   ],
 *   usage: { input_tokens, output_tokens, total_tokens }
 * }
 *
 * 输出 (Claude Messages API):
 * {
 *   id: "msg_xxx",
 *   type: "message",
 *   role: "assistant",
 *   model: "...",
 *   content: [{ type: "text", text: "..." }],
 *   stop_reason: "end_turn",
 *   stop_sequence: null,
 *   usage: { input_tokens, output_tokens }
 * }
 */
export function convertSuccessResponse(codexResponse: unknown): object | null {
  if (!isCodexSuccessResponse(codexResponse)) {
    return null;
  }

  const resp = codexResponse as {
    id: string;
    model?: string;
    output: unknown[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      reasoning_tokens?: number;
    };
  };

  // 转换 output 到 content
  const content: unknown[] = [];
  let hasToolUse = false;

  for (const item of resp.output) {
    const outputItem = item as {
      type: string;
      content?: unknown[];
      name?: string;
      call_id?: string;
      id?: string;
      arguments?: string;
      summary?: unknown[];
    };

    if (outputItem.type === "message" && Array.isArray(outputItem.content)) {
      // 消息内容
      for (const contentItem of outputItem.content) {
        const ci = contentItem as { type: string; text?: string };
        if (ci.type === "output_text" && ci.text) {
          content.push({ type: "text", text: ci.text });
        }
      }
    } else if (outputItem.type === "function_call" || outputItem.type === "custom_tool_call") {
      // 工具调用
      hasToolUse = true;
      const toolId = convertCallIdToToolId(outputItem.call_id || outputItem.id || "");
      const toolName = mapToolNameToClaude(outputItem.name || "unknown");
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(outputItem.arguments || "{}");
      } catch {
        // 解析失败使用空对象
      }
      content.push({
        type: "tool_use",
        id: toolId,
        name: toolName,
        input,
      });
    } else if (outputItem.type === "reasoning" && Array.isArray(outputItem.summary)) {
      // reasoning 转换为 thinking
      const thinkingText = outputItem.summary
        .map((s) => (s as { text?: string }).text || "")
        .join("");
      if (thinkingText) {
        content.push({
          type: "thinking",
          thinking: thinkingText,
          signature: "", // 非流式响应没有 signature
        });
      }
    }
  }

  // 转换 ID: resp_xxx -> msg_xxx
  const messageId = convertResponseIdToMessageId(resp.id);

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model: resp.model || "unknown",
    content,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0,
    },
  };
}
