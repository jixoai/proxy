/**
 * Claude Messages SSE → Codex Responses SSE 响应转换器
 */

import type {
  ClaudeSSEEvent,
  ClaudeSSEMessageStart,
  ClaudeSSEContentBlockStart,
  ClaudeSSEContentBlockDelta,
  ClaudeSSEContentBlockStop,
  ClaudeSSEMessageDelta,
  ConverterState,
} from "./types";

import { generateId } from "./constants";

/**
 * 创建初始转换器状态
 */
export function createConverterState(): ConverterState {
  return {
    sequenceNumber: 0,
    outputIndex: 0,
    currentBlockType: null,
    currentBlockIndex: -1,
    currentToolId: "",
    currentToolName: "",
    currentToolInput: null,
    currentReasoningId: "",
    currentMessageId: "",
    currentMessageOutputIndex: -1,
    currentMessageItem: null,
    thinkingContent: "",
    thinkingSignature: "",
    toolArguments: "",
    textContent: "",
    responseId: "",
    model: "",
    createdAt: Math.floor(Date.now() / 1000),
    outputItems: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

/**
 * 转换消息 ID: msg_xxx → resp_xxx
 */
function convertMessageId(msgId: string): string {
  if (msgId.startsWith("msg_")) {
    return "resp_" + msgId.slice(4);
  }
  return "resp_" + msgId;
}

/**
 * 转换工具 ID: toolu_xxx → call_xxx
 */
function convertToolId(toolId: string): string {
  if (toolId.startsWith("toolu_")) {
    return "call_" + toolId.slice(6);
  }
  return toolId;
}

function isCustomToolName(name: string): boolean {
  return name === "apply_patch";
}

function isServerToolName(name: string): boolean {
  return name === "web_search";
}

function generateObfuscationToken(): string {
  // 与 Codex SSE 中的 obfuscation 字段保持“像随机串”的外观即可（CLI 不应依赖其语义）
  return Math.random().toString(36).slice(2, 14);
}

function chunkString(text: string, chunkSize: number): string[] {
  if (!text) return [];
  const size = Math.max(1, chunkSize | 0);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function finalizePendingTextMessage(state: ConverterState): string[] {
  if (!state.currentMessageItem) return [];

  const contentPart = {
    type: "output_text",
    annotations: [],
    logprobs: [],
    text: state.textContent,
  };

  state.currentMessageItem.content = [contentPart];
  state.currentMessageItem.status = "completed";

  const outputIndex = state.currentMessageOutputIndex;

  const textDone = {
    type: "response.output_text.done",
    sequence_number: state.sequenceNumber++,
    item_id: state.currentMessageId,
    output_index: outputIndex,
    content_index: 0,
    text: state.textContent,
    logprobs: [],
  };

  const contentPartDone = {
    type: "response.content_part.done",
    sequence_number: state.sequenceNumber++,
    item_id: state.currentMessageId,
    output_index: outputIndex,
    content_index: 0,
    part: contentPart,
  };

  const itemDone = {
    type: "response.output_item.done",
    sequence_number: state.sequenceNumber++,
    output_index: outputIndex,
    item: state.currentMessageItem,
  };

  state.textContent = "";
  state.currentMessageId = "";
  state.currentMessageOutputIndex = -1;
  state.currentMessageItem = null;

  return [
    formatSSE("response.output_text.done", textDone),
    formatSSE("response.content_part.done", contentPartDone),
    formatSSE("response.output_item.done", itemDone),
  ];
}

function ensureTextMessageStarted(state: ConverterState): string[] {
  if (state.currentMessageItem) return [];

  state.currentMessageId = generateId("msg_");
  state.currentMessageOutputIndex = state.outputIndex;
  state.textContent = "";

  state.currentMessageItem = {
    id: state.currentMessageId,
    type: "message",
    status: "in_progress",
    content: [],
    role: "assistant",
  };

  state.outputItems.push(state.currentMessageItem);

  const itemAdded = {
    type: "response.output_item.added",
    sequence_number: state.sequenceNumber++,
    output_index: state.currentMessageOutputIndex,
    item: state.currentMessageItem,
  };

  const contentPartAdded = {
    type: "response.content_part.added",
    sequence_number: state.sequenceNumber++,
    item_id: state.currentMessageId,
    output_index: state.currentMessageOutputIndex,
    content_index: 0,
    part: {
      type: "output_text",
      annotations: [],
      logprobs: [],
      text: "",
    },
  };

  state.outputIndex += 1;

  return [
    formatSSE("response.output_item.added", itemAdded),
    formatSSE("response.content_part.added", contentPartAdded),
  ];
}

/**
 * 处理 message_start 事件
 */
function handleMessageStart(
  state: ConverterState,
  event: ClaudeSSEMessageStart
): string[] {
  const msg = event.message;
  state.responseId = convertMessageId(msg.id);
  // Use model name as-is from Claude response (no mapping)
  state.model = msg.model;
  state.usage.inputTokens = msg.usage.input_tokens || 0;
  state.usage.outputTokens = msg.usage.output_tokens || 0;
  state.usage.cacheReadTokens = msg.usage.cache_read_input_tokens || 0;
  state.usage.cacheCreationTokens = msg.usage.cache_creation_input_tokens || 0;

  const created = {
    type: "response.created",
    sequence_number: state.sequenceNumber++,
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      status: "in_progress",
      background: false,
      model: state.model,
      output: [],
      parallel_tool_calls: true,
      reasoning: { effort: "xhigh", summary: "detailed" },
      tools: [],
    },
  };

  const inProgress = {
    type: "response.in_progress",
    sequence_number: state.sequenceNumber++,
    response: created.response,
  };

  return [formatSSE("response.created", created), formatSSE("response.in_progress", inProgress)];
}

/**
 * 处理 content_block_start 事件
 */
function handleContentBlockStart(
  state: ConverterState,
  event: ClaudeSSEContentBlockStart
): string[] {
  const results: string[] = [];
  const block = event.content_block;
  state.currentBlockIndex = event.index;

  // Claude 会把输出拆成多个 text blocks；如果下一个 block 不是 text，
  // 说明上一段文本已结束：在这里把 pending 的文本 message 一次性 done，避免 UI 被切成几十段。
  if (block.type !== "text") {
    results.push(...finalizePendingTextMessage(state));
  }

  if (block.type === "thinking") {
    state.currentBlockType = "thinking";
    state.currentReasoningId = generateId("rs_");
    state.thinkingContent = "";
    state.thinkingSignature = block.signature || "";
    
    // Create reasoning item and add to outputItems (like we do for tool_use)
    const reasoningItem = {
      id: state.currentReasoningId,
      type: "reasoning",
      status: "in_progress",
      summary: [] as { type: string; text: string }[],
      encrypted_content: state.thinkingSignature,
    };
    state.outputItems.push(reasoningItem);
    
    // Emit output_item.added event for reasoning
    const added = {
      type: "response.output_item.added",
      sequence_number: state.sequenceNumber++,
      output_index: state.outputIndex,
      item: reasoningItem,
    };
    
    // Emit reasoning_summary_part.added event
    const summaryPartAdded = {
      type: "response.reasoning_summary_part.added",
      sequence_number: state.sequenceNumber++,
      item_id: state.currentReasoningId,
      output_index: state.outputIndex,
      summary_index: 0,
      part: {
        type: "summary_text",
        text: "",
      },
    };
    
    state.outputIndex++;

    results.push(
      formatSSE("response.output_item.added", added),
      formatSSE("response.reasoning_summary_part.added", summaryPartAdded),
    );

    return results;
  }

  if (block.type === "server_tool_use" && isServerToolName(block.name)) {
    state.currentBlockType = "server_tool_use";
    state.currentToolId = block.id;
    state.currentToolName = block.name;
    state.currentToolInput = block.input ?? null;
    state.toolArguments = "";

    const item = {
      id: generateId("ws_"),
      type: "web_search_call",
      status: "in_progress",
      action: { type: "search" },
    };

    state.outputItems.push(item);

    const added = {
      type: "response.output_item.added",
      sequence_number: state.sequenceNumber++,
      output_index: state.outputIndex,
      item,
    };

    state.outputIndex++;

    results.push(formatSSE("response.output_item.added", added));
    return results;
  }

  if (block.type === "tool_use") {
    const codexToolName = block.name;
    const isCustom = isCustomToolName(codexToolName);

    state.currentBlockType = isCustom ? "custom_tool_call" : "tool_use";
    state.currentToolId = block.id;
    state.currentToolName = block.name;
    state.currentToolInput = block.input ?? null;
    state.toolArguments = "";

    const item = isCustom
      ? {
          id: generateId("ctc_"),
          type: "custom_tool_call",
          status: "in_progress",
          input: "",
          call_id: convertToolId(block.id),
          name: codexToolName,
        }
      : {
          id: generateId("fc_"),
          type: "function_call",
          status: "in_progress",
          arguments: "",
          call_id: convertToolId(block.id),
          name: codexToolName,
        };

    state.outputItems.push(item);

    const added = {
      type: "response.output_item.added",
      sequence_number: state.sequenceNumber++,
      output_index: state.outputIndex,
      item,
    };

    state.outputIndex++;

    results.push(formatSSE("response.output_item.added", added));
    return results;
  }

  if (block.type === "text") {
    state.currentBlockType = "text";

    const started = ensureTextMessageStarted(state);
    results.push(...started);
    return results;
  }

  return results;
}

/**
 * 处理 content_block_delta 事件
 */
function handleContentBlockDelta(
  state: ConverterState,
  event: ClaudeSSEContentBlockDelta
): string[] {
  const delta = event.delta;

  if (delta.type === "thinking_delta") {
    if (state.currentBlockType !== "thinking") return [];
    state.thinkingContent += delta.thinking;

    const reasoningDelta = {
      type: "response.reasoning_summary_text.delta",
      sequence_number: state.sequenceNumber++,
      item_id: state.currentReasoningId,
      output_index: state.outputIndex - 1,
      summary_index: 0,
      delta: delta.thinking,
    };

    return [formatSSE("response.reasoning_summary_text.delta", reasoningDelta)];
  }

  if (delta.type === "input_json_delta") {
    if (
      state.currentBlockType !== "custom_tool_call" &&
      state.currentBlockType !== "tool_use" &&
      state.currentBlockType !== "server_tool_use"
    ) {
      return [];
    }

    state.toolArguments += delta.partial_json;

    // 自定义工具 (apply_patch) 在 stop 阶段做最终转换，
    // 这里不直接透传 partial_json，避免输出与最终 input 不一致。
    if (state.currentBlockType === "custom_tool_call") {
      return [];
    }

    // Anthropic server tools are executed server-side; Codex CLI should not run them locally.
    // We only expose a lightweight web_search_call item (done in content_block_stop).
    if (state.currentBlockType === "server_tool_use") {
      return [];
    }

    if (state.currentBlockType !== "tool_use") {
      return [];
    }

    const currentItem = state.outputItems[state.outputItems.length - 1] as {
      id: string;
    };

    const argsDelta = {
      type: "response.function_call_arguments.delta",
      sequence_number: state.sequenceNumber++,
      item_id: currentItem?.id || "",
      output_index: state.outputIndex - 1,
      delta: delta.partial_json,
    };

    return [formatSSE("response.function_call_arguments.delta", argsDelta)];
  }

  if (delta.type === "text_delta") {
    if (state.currentBlockType !== "text") return [];
    state.textContent += delta.text;

    const textDelta = {
      type: "response.output_text.delta",
      sequence_number: state.sequenceNumber++,
      item_id: state.currentMessageId,
      output_index: state.currentMessageOutputIndex,
      content_index: 0,
      delta: delta.text,
      logprobs: [],
    };

    return [formatSSE("response.output_text.delta", textDelta)];
  }

  // Handle signature_delta - Claude sends signature at the end of thinking block
  if (delta.type === "signature_delta") {
    if (state.currentBlockType !== "thinking") return [];
    state.thinkingSignature += delta.signature;
    
    // Update the reasoning item's encrypted_content
    const reasoningItem = state.outputItems.find(
      (item) => (item as { id?: string }).id === state.currentReasoningId
    ) as { encrypted_content?: string } | undefined;
    
    if (reasoningItem) {
      reasoningItem.encrypted_content = state.thinkingSignature;
    }
    
    // No Codex event for signature, just accumulate it
    return [];
  }

  return [];
}

/**
 * 处理 content_block_stop 事件
 */
function handleContentBlockStop(
  state: ConverterState,
  _event: ClaudeSSEContentBlockStop
): string[] {
  const results: string[] = [];

  if (state.currentBlockType === "tool_use") {
    const currentItem = state.outputItems[state.outputItems.length - 1] as {
      id: string;
      arguments: string;
      status: string;
    };

    if (currentItem) {
      // tool_use input 是 JSON object；在 Codex SSE 中对应 function_call.arguments（JSON string）
      let rawInput: Record<string, unknown> | null = null;
      if (state.toolArguments) {
        try {
          rawInput = JSON.parse(state.toolArguments) as Record<string, unknown>;
        } catch {
          rawInput = null;
        }
      } else if (state.currentToolInput && typeof state.currentToolInput === "object") {
        rawInput = state.currentToolInput as Record<string, unknown>;
      }

      // 透传输入对象
      let finalArguments = state.toolArguments || (rawInput ? JSON.stringify(rawInput) : "{}");

      try {
        // 验证 finalArguments 是 JSON
        JSON.parse(finalArguments);
      } catch {
        finalArguments = "{}";
      }

      currentItem.arguments = finalArguments;
      currentItem.status = "completed";

      const argsDone = {
        type: "response.function_call_arguments.done",
        sequence_number: state.sequenceNumber++,
        item_id: currentItem.id,
        output_index: state.outputIndex - 1,
        arguments: finalArguments,
      };

      const itemDone = {
        type: "response.output_item.done",
        sequence_number: state.sequenceNumber++,
        output_index: state.outputIndex - 1,
        item: currentItem,
      };

      results.push(
        formatSSE("response.function_call_arguments.done", argsDone),
        formatSSE("response.output_item.done", itemDone)
      );
    }

    state.toolArguments = "";
    state.currentToolInput = null;
  }

  if (state.currentBlockType === "custom_tool_call") {
    const currentItem = state.outputItems[state.outputItems.length - 1] as {
      id: string;
      input: string;
      status: string;
      name: string;
    };

    if (currentItem) {
      let rawInput: Record<string, unknown> | null = null;
      if (state.toolArguments) {
        try {
          rawInput = JSON.parse(state.toolArguments) as Record<string, unknown>;
        } catch {
          rawInput = null;
        }
      } else if (state.currentToolInput && typeof state.currentToolInput === "object") {
        rawInput = state.currentToolInput as Record<string, unknown>;
      }

      const patch =
        rawInput && typeof rawInput.patch === "string"
          ? rawInput.patch
          : rawInput && typeof rawInput.content === "string"
            ? rawInput.content
            : rawInput && typeof rawInput.input === "string"
              ? rawInput.input
              : "";

      currentItem.input = patch;
      currentItem.status = "completed";

      for (const chunk of chunkString(patch, 32)) {
        const inputDelta = {
          type: "response.custom_tool_call_input.delta",
          sequence_number: state.sequenceNumber++,
          output_index: state.outputIndex - 1,
          item_id: currentItem.id,
          delta: chunk,
          obfuscation: generateObfuscationToken(),
        };
        results.push(formatSSE("response.custom_tool_call_input.delta", inputDelta));
      }

      const inputDone = {
        type: "response.custom_tool_call_input.done",
        sequence_number: state.sequenceNumber++,
        output_index: state.outputIndex - 1,
        item_id: currentItem.id,
        input: patch,
      };

      const itemDone = {
        type: "response.output_item.done",
        sequence_number: state.sequenceNumber++,
        output_index: state.outputIndex - 1,
        item: currentItem,
      };

      results.push(
        formatSSE("response.custom_tool_call_input.done", inputDone),
        formatSSE("response.output_item.done", itemDone)
      );
    }

    state.toolArguments = "";
    state.currentToolInput = null;
  }

  if (state.currentBlockType === "server_tool_use") {
    const currentItem = state.outputItems[state.outputItems.length - 1] as {
      id: string;
      type: string;
      status: string;
      action: Record<string, unknown>;
    };

    if (currentItem) {
      let rawInput: Record<string, unknown> | null = null;
      if (state.toolArguments) {
        try {
          rawInput = JSON.parse(state.toolArguments) as Record<string, unknown>;
        } catch {
          rawInput = null;
        }
      } else if (state.currentToolInput && typeof state.currentToolInput === "object") {
        rawInput = state.currentToolInput as Record<string, unknown>;
      }

      const query = rawInput && typeof rawInput.query === "string" ? rawInput.query : undefined;

      currentItem.action = query ? { type: "search", query } : { type: "search" };
      currentItem.status = "completed";

      const itemDone = {
        type: "response.output_item.done",
        sequence_number: state.sequenceNumber++,
        output_index: state.outputIndex - 1,
        item: currentItem,
      };

      results.push(formatSSE("response.output_item.done", itemDone));
    }

    state.toolArguments = "";
    state.currentToolInput = null;
  }

  if (state.currentBlockType === "thinking") {
    // Find the reasoning item we created in handleContentBlockStart
    const reasoningItem = state.outputItems.find(
      (item) => (item as { id?: string }).id === state.currentReasoningId
    ) as {
      id: string;
      type: string;
      status: string;
      summary: { type: string; text: string }[];
      encrypted_content: string;
    } | undefined;

    if (reasoningItem) {
      // Update the reasoning item with content
      reasoningItem.summary = [{ type: "summary_text", text: state.thinkingContent }];
      reasoningItem.status = "completed";

      // Emit reasoning_summary_text.done event
      const reasoningDone = {
        type: "response.reasoning_summary_text.done",
        sequence_number: state.sequenceNumber++,
        item_id: state.currentReasoningId,
        output_index: state.outputIndex - 1,
        summary_index: 0,
        text: state.thinkingContent,
      };

      // Emit reasoning_summary_part.done event
      const summaryPartDone = {
        type: "response.reasoning_summary_part.done",
        sequence_number: state.sequenceNumber++,
        item_id: state.currentReasoningId,
        output_index: state.outputIndex - 1,
        summary_index: 0,
        part: {
          type: "summary_text",
          text: state.thinkingContent,
        },
      };

      // Emit output_item.done event for reasoning
      const itemDone = {
        type: "response.output_item.done",
        sequence_number: state.sequenceNumber++,
        output_index: state.outputIndex - 1,
        item: reasoningItem,
      };

      results.push(
        formatSSE("response.reasoning_summary_text.done", reasoningDone),
        formatSSE("response.reasoning_summary_part.done", summaryPartDone),
        formatSSE("response.output_item.done", itemDone)
      );
    }

    state.thinkingContent = "";
    state.thinkingSignature = "";
  }

  // text block: do not finalize message here; we merge consecutive text blocks into a single message item.

  state.currentBlockType = null;
  return results;
}

/**
 * 处理 message_delta 事件
 */
function handleMessageDelta(
  state: ConverterState,
  event: ClaudeSSEMessageDelta
): string[] {
  state.usage.outputTokens = event.usage.output_tokens || state.usage.outputTokens;
  return [];
}

/**
 * 处理 message_stop 事件
 */
function handleMessageStop(state: ConverterState): string[] {
  const flushedText = finalizePendingTextMessage(state);

  const completed = {
    type: "response.completed",
    sequence_number: state.sequenceNumber++,
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      status: "completed",
      model: state.model,
      output: state.outputItems,
      usage: {
        input_tokens:
          state.usage.inputTokens +
          state.usage.cacheReadTokens +
          state.usage.cacheCreationTokens,
        output_tokens: state.usage.outputTokens,
        total_tokens:
          state.usage.inputTokens +
          state.usage.cacheReadTokens +
          state.usage.cacheCreationTokens +
          state.usage.outputTokens,
        input_tokens_details: {
          cached_tokens: state.usage.cacheReadTokens,
        },
        output_tokens_details: {
          reasoning_tokens: 0,
        },
      },
    },
  };

  return [...flushedText, formatSSE("response.completed", completed)];
}

/**
 * 检测是否为 Claude 上下文过长错误 (SSE 事件中的错误)
 * Claude 返回的错误消息可能包含：
 * - "prompt is too long"
 * - "request too large"
 * - "maximum context length"
 */
function isClaudeContextLengthError(error: { type?: string; message?: string; code?: number | string }): boolean {
  const message = error.message?.toLowerCase() || "";
  return (
    message.includes("prompt is too long") ||
    message.includes("request too large") ||
    message.includes("maximum context length") ||
    message.includes("too many tokens") ||
    message.includes("context length exceeded") ||
    message.includes("input is too long")
  );
}

/**
 * 检测是否为上游请求失败错误 (SSE 事件中的错误)
 */
function isUpstreamError(error: { type?: string; message?: string; code?: number | string }): boolean {
  const code = error.code;
  return (
    (code === 400 || code === "400") &&
    error.type === "server_error" &&
    error.message === "Upstream request failed"
  );
}

/**
 * 检测是否需要转换为 context_length_exceeded (SSE)
 */
function shouldConvertErrorToContextLength(error: { type?: string; message?: string; code?: number | string }): boolean {
  return isClaudeContextLengthError(error) || isUpstreamError(error);
}

/**
 * 构建 Codex 格式的 context_length_exceeded 错误
 * 这个格式能被 Codex CLI 识别并触发 auto-compact
 */
function buildContextLengthExceededError(
  state: ConverterState,
  originalMessage: string
): object {
  return {
    type: "response.failed",
    sequence_number: state.sequenceNumber++,
    response: {
      id: state.responseId || `resp_${Date.now()}`,
      object: "response",
      status: "failed",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: `context length exceeded: ${originalMessage}`,
      },
    },
  };
}

/**
 * 处理 error 事件
 * 特别处理上下文过长错误和上游请求失败错误，转换为 Codex 能识别的格式以触发 auto-compact
 */
function handleError(
  state: ConverterState,
  event: { error: { type?: string; message?: string; code?: number | string } }
): string[] {
  // 检测是否需要转换为 context_length_exceeded (包括上下文过长和上游请求失败)
  if (shouldConvertErrorToContextLength(event.error)) {
    const contextError = buildContextLengthExceededError(state, event.error.message || "Upstream request failed");
    return [formatSSE("response.failed", contextError)];
  }

  // 其他错误正常处理
  const failed = {
    type: "response.failed",
    sequence_number: state.sequenceNumber++,
    response: {
      id: state.responseId || `resp_${Date.now()}`,
      object: "response",
      status: "failed",
      error: {
        type: event.error.type,
        message: event.error.message,
      },
    },
  };

  return [formatSSE("response.failed", failed)];
}

/**
 * 格式化 SSE 事件
 * 注意：使用 "event:xxx" 格式（无空格），与原生 Codex 响应保持一致
 */
function formatSSE(event: string, data: unknown): string {
  return `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
}

/**
 * 解析 SSE 行
 */
export function parseSSELine(line: string): { event?: string; data?: string } | null {
  if (line.startsWith("event:")) {
    return { event: line.slice(6).trim() };
  }
  if (line.startsWith("data:")) {
    return { data: line.slice(5).trim() };
  }
  return null;
}

/**
 * 处理单个 Claude SSE 事件
 */
export function processClaudeEvent(
  state: ConverterState,
  eventType: string,
  eventData: ClaudeSSEEvent
): string[] {
  switch (eventType) {
    case "message_start":
      return handleMessageStart(state, eventData as ClaudeSSEMessageStart);

    case "content_block_start":
      return handleContentBlockStart(state, eventData as ClaudeSSEContentBlockStart);

    case "content_block_delta":
      return handleContentBlockDelta(state, eventData as ClaudeSSEContentBlockDelta);

    case "content_block_stop":
      return handleContentBlockStop(state, eventData as ClaudeSSEContentBlockStop);

    case "message_delta":
      return handleMessageDelta(state, eventData as ClaudeSSEMessageDelta);

    case "message_stop":
      return handleMessageStop(state);

    case "error":
      return handleError(state, eventData as { error: { type: string; message: string } });

    case "ping":
      return [];

    default:
      return [];
  }
}

/**
 * SSE 流转换器
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
   * @returns 转换后的 Codex SSE 事件
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
        if (dataStr === "[DONE]") continue;

        try {
          const data = JSON.parse(dataStr) as ClaudeSSEEvent;
          const eventType = this.currentEvent || data.type;
          const events = processClaudeEvent(this.state, eventType, data);
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
   */
  finish(): string {
    if (this.buffer.trim()) {
      return this.processChunk("\n");
    }
    return "";
  }
}

/**
 * 转换完整的 SSE 响应体
 */
export function convertSSEResponse(claudeSSE: string): string {
  const converter = new SSEStreamConverter();
  let result = converter.processChunk(claudeSSE);
  result += converter.finish();
  return result;
}

// ============================================================================
// 错误响应处理 (非 SSE 格式)
// ============================================================================

/**
 * 检测是否为 Claude 上下文过长错误 (JSON 响应)
 */
export function isContextLengthError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const err = body as { type?: string; error?: { type?: string; message?: string } };
  
  if (err.type !== "error" || !err.error?.message) return false;
  
  const message = err.error.message.toLowerCase();
  return (
    message.includes("prompt is too long") ||
    message.includes("request too large") ||
    message.includes("maximum context length") ||
    message.includes("too many tokens") ||
    message.includes("context length exceeded") ||
    message.includes("input is too long")
  );
}

/**
 * 检测是否为上游请求失败错误
 * Claude 有时会返回这种格式的错误，需要转换为 context_length_exceeded 以触发 auto-compact
 * 
 * 错误格式:
 * {
 *   "type": "error",
 *   "error": {
 *     "code": 400,
 *     "type": "server_error",
 *     "message": "Upstream request failed"
 *   }
 * }
 */
export function isUpstreamRequestFailedError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const err = body as { type?: string; error?: { code?: number | string; type?: string; message?: string } };
  
  if (err.type !== "error") return false;
  if (!err.error) return false;
  
  const upstreamError = err.error;
  const upstreamCode = upstreamError.code;
  
  // code 必须是 400 (数字或字符串)
  if (upstreamCode !== 400 && upstreamCode !== "400") return false;
  // type 必须是 server_error
  if (upstreamError.type !== "server_error") return false;
  // message 必须是 "Upstream request failed"
  if (upstreamError.message !== "Upstream request failed") return false;
  
  return true;
}

/**
 * 检测是否需要转换为 context_length_exceeded 错误
 * 包括：上下文过长错误 + 上游请求失败错误
 */
export function shouldConvertToContextLengthError(body: unknown): boolean {
  return isContextLengthError(body) || isUpstreamRequestFailedError(body);
}

/**
 * 构建 Codex 格式的 context_length_exceeded JSON 响应
 * 用于非 SSE 格式的错误响应转换
 */
export function buildCodexContextLengthError(originalMessage?: string): object {
  return {
    type: "error",
    message: "context length exceeded",
    error: {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: originalMessage || "context length exceeded",
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * 转换 Claude 错误响应为 Codex 格式
 * 处理两种情况：
 * 1. 上下文过长错误 (prompt is too long 等)
 * 2. 上游请求失败错误 (Upstream request failed)
 * 
 * @returns 转换后的响应体，如果不需要转换则返回 null
 */
export function convertErrorResponse(claudeError: unknown): object | null {
  if (!shouldConvertToContextLengthError(claudeError)) {
    return null;
  }
  
  const err = claudeError as { error?: { message?: string } };
  return buildCodexContextLengthError(err.error?.message);
}
