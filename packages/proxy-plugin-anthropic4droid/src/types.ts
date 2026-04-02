import Anthropic from "@anthropic-ai/sdk";
import type {
  RawContentBlockDelta,
  TextBlockParam,
  ThinkingBlockParam,
} from "@anthropic-ai/sdk/resources";
/**
 * Droid 请求相关类型定义
 */

export type CacheControl = { type: "ephemeral" };

export type TextBlock = TextBlockParam;
export type ThinkingBlock = ThinkingBlockParam;

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type Message = {
  role: MessageRole;
  content?: string | Array<TextBlock | ThinkingBlock>;
};

export type ToolParamSchema = { description?: string };

export type Tool = {
  name: string;
  description?: string;
  input_schema?: { properties?: Record<string, ToolParamSchema> };
};

/**
 * Claude web_search server tool (web_search_20250305)
 */
export type WebSearchTool = {
  type: "web_search_20250305";
  name: "web_search";
  max_uses?: number;
};

/**
 * Tool can be either a regular tool or a web_search server tool
 */
export type AnyTool = Tool | WebSearchTool;

/**
 * Check if tool is a web_search server tool
 */
export function isWebSearchTool(tool: AnyTool): tool is WebSearchTool {
  return "type" in tool && tool.type === "web_search_20250305";
}

export type RequestBody = {
  model?: string;
  system?: string | TextBlock[];
  messages?: Message[];
  tools?: AnyTool[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
  max_tokens?: number;
  stream?: boolean;
};

export type RewriteResult = {
  headers?: Record<string, string>;
  body?: string;
  url?: string;
};
