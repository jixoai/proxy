/**
 * OpenAI Responses API 请求相关类型定义
 */

/**
 * OpenAI function tool
 */
export interface FunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

/**
 * OpenAI web_search tool
 */
export interface WebSearchTool {
  type: "web_search";
}

/**
 * Tool can be either a function tool or a web_search tool
 */
export type AnyTool = FunctionTool | WebSearchTool;

/**
 * Check if tool is a web_search tool
 */
export function isWebSearchTool(tool: AnyTool): tool is WebSearchTool {
  return tool.type === "web_search";
}

/**
 * Content item types
 */
export interface InputTextContent {
  type: "input_text";
  text: string;
}

export interface OutputTextContent {
  type: "output_text";
  text: string;
}

export type ContentItem = InputTextContent | OutputTextContent;

/**
 * Input item types
 */
export interface MessageItem {
  type?: "message";
  role: "user" | "assistant" | "developer";
  content: ContentItem[] | string;
}

export interface FunctionCallItem {
  type: "function_call";
  id?: string;
  name: string;
  arguments: string;
  call_id: string;
  status?: string;
}

export interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string | ContentItem[];
}

export interface WebSearchCallItem {
  type: "web_search_call";
  id?: string;
  status?: string;
  action?: {
    type: "search" | "open_page" | "find_in_page" | string;
    query?: string;
    url?: string;
  };
}

export type InputItem = MessageItem | FunctionCallItem | FunctionCallOutputItem | WebSearchCallItem;

/**
 * Reasoning configuration
 */
export interface ReasoningConfig {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "detailed" | "none";
}

/**
 * OpenAI Responses API request body
 */
export interface RequestBody {
  model?: string;
  instructions?: string;
  input?: InputItem[] | string;
  tools?: AnyTool[];
  tool_choice?: string | { type: string; name?: string };
  parallel_tool_calls?: boolean;
  reasoning?: ReasoningConfig;
  stream?: boolean;
  store?: boolean;
  include?: string[];
  text?: Record<string, unknown>;
  max_output_tokens?: number;
}

export interface RewriteResult {
  headers?: Record<string, string>;
  body?: string;
}
