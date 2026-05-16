/**
 * Gemini4Droid 类型定义
 *
 * Anthropic Messages API 和 Gemini generateContent API 的类型
 */

// ============================================================================
// Anthropic Messages API Types (输入格式)
// ============================================================================

export type CacheControl = { type: "ephemeral" };

export type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
  /** 私有字段：保留 Gemini thoughtSignature，下一轮请求会原样传回 Gemini */
  gemini_thought_signature?: string;
};

export type AnthropicImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** 私有字段：保留 Gemini functionCall part 的 thoughtSignature */
  gemini_thought_signature?: string;
};

export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
};

export type AnthropicThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export type AnthropicMessageRole = "user" | "assistant";

export type AnthropicMessage = {
  role: AnthropicMessageRole;
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

export type AnthropicThinkingConfig = {
  type: "enabled" | "disabled";
  budget_tokens?: number;
};

export type AnthropicOutputConfig = {
  effort?: "low" | "medium" | "high";
};

export type AnthropicRequestBody = {
  model?: string;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  /** Extended thinking 配置 */
  thinking?: AnthropicThinkingConfig;
  /** 输出配置 */
  output_config?: AnthropicOutputConfig;
};

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use";

export type AnthropicResponseBody = {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export type AnthropicErrorResponse = {
  type: "error";
  error: {
    type: string;
    code?: string;
    message: string;
  };
};

// ============================================================================
// Gemini API Types (输出格式)
// ============================================================================

export type GeminiRole = "user" | "model";

export type GeminiTextPart = {
  text: string;
  /** 标记这是 thinking 内容 */
  thought?: boolean;
  /** thinking 签名（表示 thinking 结束） */
  thoughtSignature?: string;
};

export type GeminiInlineDataPart = {
  inline_data: {
    mime_type: string;
    data: string;
  };
};

export type GeminiFunctionCallPart = {
  /** 标准 Gemini API 格式 */
  function_call?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  /** Gemini CLI 格式 (camelCase) */
  functionCall?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  /** Gemini 3/2.5 thinking 模型返回的签名，历史中需要原样传回 */
  thoughtSignature?: string;
};

export type GeminiFunctionResponsePart = {
  /** 标准 Gemini API 格式 */
  function_response?: {
    name: string;
    response: Record<string, unknown>;
  };
  /** Gemini CLI 格式 */
  functionResponse?: {
    id: string;
    name: string;
    response: {
      output?: string;
      error?: string;
      [key: string]: unknown;
    };
  };
};

export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export type GeminiContent = {
  role: GeminiRole;
  parts: GeminiPart[];
};

export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  /** Gemini CLI 使用 parametersJsonSchema 而不是 parameters */
  parametersJsonSchema?: {
    type?: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    $schema?: string;
  };
  /** 标准 Gemini API 使用 parameters */
  parameters?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export type GeminiToolConfig = {
  functionCallingConfig?: {
    mode: "AUTO" | "ANY" | "NONE";
    allowedFunctionNames?: string[];
  };
};

export type GeminiThinkingConfig = {
  /** 是否包含 thinking 内容 */
  includeThoughts?: boolean;
  /** thinking token 预算 */
  thinkingBudget?: number;
};

export type GeminiGenerationConfig = {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  candidateCount?: number;
  thinkingConfig?: GeminiThinkingConfig;
};

export type GeminiSafetySettings = {
  category: string;
  threshold: string;
}[];

export type GeminiRequestBody = {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: GeminiTextPart[];
  };
  tools?: Array<
    | { functionDeclarations?: GeminiFunctionDeclaration[] }
    | { googleSearch: Record<string, never> }
  >;
  toolConfig?: GeminiToolConfig;
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: GeminiSafetySettings;
};

export type GeminiFinishReason =
  | "STOP"
  | "MAX_TOKENS"
  | "SAFETY"
  | "RECITATION"
  | "OTHER"
  | "BLOCKLIST"
  | "PROHIBITED_CONTENT"
  | "SPII";

export type GeminiCandidate = {
  content: GeminiContent;
  finishReason?: GeminiFinishReason;
  safetyRatings?: Array<{
    category: string;
    probability: string;
    blocked?: boolean;
  }>;
  citationMetadata?: {
    citationSources: Array<{
      startIndex?: number;
      endIndex?: number;
      uri?: string;
      license?: string;
    }>;
  };
  tokenCount?: number;
  index?: number;
};

export type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
};

export type GeminiResponseBody = {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  createTime?: string;
  responseId?: string;
};

export type GeminiErrorResponse = {
  error: {
    code: number;
    message: string;
    status: string;
    details?: unknown[];
  };
};

// ============================================================================
// Conversion Result Types
// ============================================================================

export type RequestConversionResult = {
  url?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type ResponseConversionResult = {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: Buffer;
  converted: boolean;
};
