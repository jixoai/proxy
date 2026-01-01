/**
 * Droid 请求相关类型定义
 */

export type CacheControl = { type: "ephemeral" };

export type TextBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type Message = {
  role: MessageRole;
  content?: string | TextBlock[];
};

export type ToolParamSchema = { description?: string };

export type Tool = {
  name: string;
  description?: string;
  input_schema?: { properties?: Record<string, ToolParamSchema> };
};

export type RequestBody = {
  model?: string;
  system?: string | TextBlock[];
  messages?: Message[];
  tools?: Tool[];
  metadata?: Record<string, unknown>;
  max_tokens?: number;
  stream?: boolean;
};

export type RewriteResult = {
  headers?: Record<string, string>;
  body?: string;
};
