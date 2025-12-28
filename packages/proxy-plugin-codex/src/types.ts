/**
 * Codex Responses API 类型定义
 */

// ============================================================================
// Codex Responses API Types
// ============================================================================

export type CodexContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string };

export type CodexReasoningSummary = {
  type: "summary_text";
  text: string;
};

export type CodexReasoningContent =
  | { type: "reasoning_text"; text: string }
  | { type: "text"; text: string };

export type CodexResponseItem =
  | {
      type: "message";
      id?: string;
      role: "user" | "assistant";
      content: CodexContentItem[];
    }
  | {
      type: "reasoning";
      id?: string;
      summary: CodexReasoningSummary[];
      content?: CodexReasoningContent[];
      encrypted_content?: string;
    }
  | {
      type: "function_call";
      id?: string;
      name: string;
      arguments: string; // JSON string
      call_id: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
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
    }
  | {
      type: "ghost_snapshot";
      ghost_commit: unknown;
    }
  | {
      type: "compaction";
      encrypted_content: string;
    };

export interface CodexTool {
  type: "function" | "web_search" | "custom";
  name?: string;
  description?: string;
  strict?: boolean;
  parameters?: Record<string, unknown>;
  format?: { type: string; syntax: string; definition: string };
}

export interface CodexReasoning {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "detailed" | "none";
}

export interface CodexTextControls {
  verbosity?: "low" | "medium" | "high";
  format?: {
    type: string;
    strict: boolean;
    schema: Record<string, unknown>;
    name: string;
  };
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
  stream?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  text?: CodexTextControls;
  max_output_tokens?: number;
}

// ============================================================================
// Claude Messages API Types
// ============================================================================

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ClaudeContentBlock[];
      is_error?: boolean;
    }
  | {
      type: "thinking";
      thinking: string;
      signature: string;
    };

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: ClaudeContentBlock[] | string;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeThinking {
  type: "enabled";
  budget_tokens: number;
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string | Array<{ type: "text"; text: string; cache_control?: { type: string } }>;
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
  tool_choice?: { type: string } | { type: "tool"; name: string };
  thinking?: ClaudeThinking;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// SSE Event Types
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
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
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

export type ClaudeSSEEvent =
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

export interface ConverterState {
  sequenceNumber: number;
  outputIndex: number;
  currentBlockType: "thinking" | "tool_use" | "text" | null;
  currentBlockIndex: number;
  currentToolId: string;
  currentToolName: string;
  currentReasoningId: string;
  currentMessageId: string;
  currentMessageItem: {
    id: string;
    type: "message";
    status: string;
    content: Array<{ type: string; text: string; annotations: unknown[]; logprobs: unknown[] }>;
    role: "assistant";
  } | null;
  thinkingContent: string;
  thinkingSignature: string;
  toolArguments: string;
  textContent: string;
  responseId: string;
  model: string;
  createdAt: number;
  outputItems: unknown[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

export interface ConvertResult {
  headers?: Record<string, string>;
  body?: string;
}
