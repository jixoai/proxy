/**
 * Claude → Codex 转换器类型定义
 */

// ============================================================================
// Claude Messages API Types (输入)
// ============================================================================

export type ClaudeCacheControl = { type: "ephemeral"; ttl?: string };

export type ClaudeTextBlock = {
  type: "text";
  text: string;
  cache_control?: ClaudeCacheControl;
};

export type ClaudeImageBlock = {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  cache_control?: ClaudeCacheControl;
};

export type ClaudeToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: ClaudeCacheControl;
};

export type ClaudeToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | ClaudeContentBlock[];
  is_error?: boolean;
  cache_control?: ClaudeCacheControl;
};

export type ClaudeThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
  cache_control?: ClaudeCacheControl;
};

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeThinkingBlock;

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: ClaudeContentBlock[] | string;
}

export interface ClaudeSystemBlock {
  type: "text";
  text: string;
  cache_control?: ClaudeCacheControl;
}

export interface ClaudeClientTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeServerTool {
  type: string;
  name: string;
  [key: string]: unknown;
}

export type ClaudeTool = ClaudeClientTool | ClaudeServerTool;

export interface ClaudeThinkingConfig {
  type: "enabled";
  budget_tokens: number;
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string | ClaudeSystemBlock[];
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
  tool_choice?: { type: string } | { type: "tool"; name: string };
  thinking?: ClaudeThinkingConfig;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Codex Responses API Types (输出)
// ============================================================================

export type CodexContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string };

export type CodexReasoningSummary = {
  type: "summary_text";
  text: string;
};

export type CodexResponseItem =
  | {
      type: "message";
      id?: string;
      role: "user" | "assistant" | "developer";
      content: CodexContentItem[];
    }
  | {
      type: "reasoning";
      id?: string;
      summary: CodexReasoningSummary[];
      encrypted_content?: string;
    }
  | {
      type: "function_call";
      id?: string;
      name: string;
      arguments: string;
      call_id: string;
      status?: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string | CodexContentItem[];
    }
  | {
      type: "custom_tool_call";
      id?: string;
      name: string;
      input: string;
      call_id: string;
      status?: string;
    }
  | {
      type: "custom_tool_call_output";
      call_id: string;
      output: string;
    }
  | {
      type: "web_search_call";
      id?: string;
      status?: string;
      action: { type: "search"; query?: string } | { type: string };
    }
  | {
      type: "local_shell_call";
      id?: string;
      call_id?: string;
      status?: string;
      action: {
        type: "exec";
        command: string[];
        timeout_ms?: number;
        working_directory?: string;
      };
    }
  | {
      type: "local_shell_call_output";
      call_id: string;
      output: string;
    };

export interface CodexTool {
  type: "function" | "web_search" | "custom";
  name?: string;
  description?: string;
  strict?: boolean;
  parameters?: Record<string, unknown>;
  format?: Record<string, unknown>;
}

export interface CodexReasoning {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "detailed" | "none";
}

export interface CodexRequest {
  model: string;
  instructions: string;
  input: CodexResponseItem[];
  tools?: CodexTool[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  reasoning?: CodexReasoning;
  store?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  text?: Record<string, unknown>;
  stream?: boolean;
  // Note: max_output_tokens was removed from Codex API
}

// ============================================================================
// Codex SSE Event Types (响应输入)
// ============================================================================

export interface CodexSSEResponseCreated {
  type: "response.created";
  sequence_number: number;
  response: {
    id: string;
    object: string;
    created_at: number;
    status: string;
    model: string;
    output: unknown[];
  };
}

export interface CodexSSEResponseInProgress {
  type: "response.in_progress";
  sequence_number: number;
  response: {
    id: string;
    status: string;
  };
}

export interface CodexSSEOutputItemAdded {
  type: "response.output_item.added";
  sequence_number: number;
  output_index: number;
  item: {
    id: string;
    type: string;
    status?: string;
    role?: string;
    content?: unknown[];
    name?: string;
    call_id?: string;
    arguments?: string;
    input?: string;
    summary?: unknown[];
    encrypted_content?: string;
    // web_search_call specific fields
    action?: WebSearchAction;
  };
}

export interface WebSearchAction {
  type: "search" | "open_page" | "find_in_page" | string;
  query?: string;
  url?: string;
  pattern?: string;
}

export interface CodexSSEContentPartAdded {
  type: "response.content_part.added";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  part: {
    type: string;
    text?: string;
    annotations?: unknown[];
  };
}

export interface CodexSSEOutputTextDelta {
  type: "response.output_text.delta";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface CodexSSEOutputTextDone {
  type: "response.output_text.done";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

export interface CodexSSEReasoningSummaryDelta {
  type: "response.reasoning_summary.delta";
  sequence_number: number;
  item_id: string;
  output_index: number;
  summary_index: number;
  delta: string;
}

export interface CodexSSEReasoningSummaryDone {
  type: "response.reasoning_summary.done";
  sequence_number: number;
  item_id: string;
  output_index: number;
  summary_index: number;
  text: string;
}

export interface CodexSSEFunctionCallArgumentsDelta {
  type: "response.function_call_arguments.delta";
  sequence_number: number;
  item_id: string;
  output_index: number;
  delta: string;
}

export interface CodexSSEFunctionCallArgumentsDone {
  type: "response.function_call_arguments.done";
  sequence_number: number;
  item_id: string;
  output_index: number;
  arguments: string;
}

export interface CodexSSEOutputItemDone {
  type: "response.output_item.done";
  sequence_number: number;
  output_index: number;
  item: {
    id: string;
    type: string;
    status?: string;
    role?: string;
    content?: unknown[];
    name?: string;
    call_id?: string;
    arguments?: string;
    input?: string;
    summary?: unknown[];
    // web_search_call specific fields
    action?: WebSearchAction;
  };
}

export interface CodexSSEAnnotationAdded {
  type: "response.output_text.annotation.added";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  annotation_index: number;
  annotation: {
    type: "url_citation" | string;
    start_index: number;
    end_index: number;
    title?: string;
    url?: string;
  };
}

export interface CodexSSEContentPartDone {
  type: "response.content_part.done";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  part: {
    type: string;
    text?: string;
  };
}

export interface CodexSSEResponseCompleted {
  type: "response.completed";
  sequence_number: number;
  response: {
    id: string;
    status: string;
    model: string;
    output: unknown[];
    usage: {
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens?: number;
      total_tokens: number;
    };
  };
}

export interface CodexSSEError {
  type: "error";
  sequence_number?: number;
  error: {
    type: string;
    code?: string;
    message: string;
  };
}

export type CodexSSEEvent =
  | CodexSSEResponseCreated
  | CodexSSEResponseInProgress
  | CodexSSEOutputItemAdded
  | CodexSSEContentPartAdded
  | CodexSSEOutputTextDelta
  | CodexSSEOutputTextDone
  | CodexSSEReasoningSummaryDelta
  | CodexSSEReasoningSummaryDone
  | CodexSSEFunctionCallArgumentsDelta
  | CodexSSEFunctionCallArgumentsDone
  | CodexSSEOutputItemDone
  | CodexSSEContentPartDone
  | CodexSSEAnnotationAdded
  | CodexSSEResponseCompleted
  | CodexSSEError;

// ============================================================================
// Claude SSE Event Types (响应输出)
// ============================================================================

export interface ClaudeSSEMessageStart {
  type: "message_start";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: unknown[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface ClaudeSSEContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "web_search_tool_result"; tool_use_id: string; content: WebSearchResult[] };
}

export interface WebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  encrypted_content: string;
  page_age?: string;
}

export interface ClaudeSSEContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "thinking_delta"; thinking: string }
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "signature_delta"; signature: string };
}

export interface ClaudeSSEContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface ClaudeSSEMessageDelta {
  type: "message_delta";
  delta: {
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface ClaudeSSEMessageStop {
  type: "message_stop";
}

export interface ClaudeSSEPing {
  type: "ping";
}

export interface ClaudeSSEError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

export type ClaudeSSEEventOut =
  | ClaudeSSEMessageStart
  | ClaudeSSEContentBlockStart
  | ClaudeSSEContentBlockDelta
  | ClaudeSSEContentBlockStop
  | ClaudeSSEMessageDelta
  | ClaudeSSEMessageStop
  | ClaudeSSEPing
  | ClaudeSSEError;

// ============================================================================
// Converter State
// ============================================================================

export interface UrlCitation {
  url: string;
  title: string;
}

export interface WebSearchCallState {
  /** Codex item ID */
  itemId: string;
  /** Claude server_tool_use ID */
  toolUseId: string;
  /** 搜索查询 */
  query: string;
  /** 该次搜索产生的引用（最佳努力归属） */
  citations: UrlCitation[];
  /** 是否已发送 web_search_tool_result */
  resultSent: boolean;
}

export interface ConverterState {
  /** Claude message ID */
  messageId: string;
  /** 模型名称 */
  model: string;
  /** 当前 content block 索引 */
  contentBlockIndex: number;
  /** 当前块类型 */
  currentBlockType: "text" | "tool_use" | "server_tool_use" | "web_search_tool_result" | null;
  /** 当前块的 item_id (Codex) */
  currentItemId: string;
  /** 当前 tool_use 的 ID */
  currentToolId: string;
  /** 当前 tool_use 的 name */
  currentToolName: string;
  /** 累积的 tool input JSON */
  toolInputJson: string;
  /** 累积的 text 内容 */
  textContent: string;
  /** Usage 统计 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  /** 是否已发送 message_start */
  messageStarted: boolean;
  /** 是否已发送当前 block 的 start */
  blockStarted: boolean;
  /** 响应创建时间 */
  createdAt: number;
  /** Web 搜索相关状态（支持多个并发搜索） */
  webSearchCalls: WebSearchCallState[];
  /** 当前活跃的 web_search_call ID（用于关联 url_citation） */
  activeWebSearchItemId: string;
  /** 收集的 URL 引用（用于 web_search_tool_result） */
  urlCitations: UrlCitation[];
  /** 是否包含 tool_use 调用（用于设置 stop_reason） */
  hasToolUse: boolean;
  /** 待处理的函数调用参数（当 delta 事件先于 output_item.added 到达时） */
  pendingFunctionCalls: Map<string, { outputIndex: number; arguments: string }>;
  /** 流是否正常完成（收到 response.completed） */
  streamCompleted: boolean;
}

// ============================================================================
// Convert Result
// ============================================================================

export interface ConvertResult {
  headers?: Record<string, string>;
  body?: string;
}
