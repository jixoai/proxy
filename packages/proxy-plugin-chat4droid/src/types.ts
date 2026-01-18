export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AnthropicSystemBlock = { type: "text"; text: string; cache_control?: { type: string } };

export type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: { type: string } }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, JsonValue>;
      cache_control?: { type: string };
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
      cache_control?: { type: string };
    }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
      cache_control?: { type: string };
    };

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema?: Record<string, JsonValue>;
  [key: string]: JsonValue | undefined;
};

export type AnthropicToolChoice = { type: "auto" | "any" | "tool"; name?: string } | { type: string };

export type AnthropicMessagesRequest = {
  model: string;
  max_tokens: number;
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  // Extra fields are ignored by converter; keep open-ended for forward compatibility.
  [key: string]: unknown;
};

export type OpenAIChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: "text"; text: string }>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

export type OpenAIChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, JsonValue>;
  };
};

export type OpenAIToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export type OpenAIChatCompletionRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: OpenAIChatTool[];
  tool_choice?: OpenAIToolChoice;
  // Extra fields optional for provider-specific features; we intentionally keep output minimal.
  [key: string]: unknown;
};

