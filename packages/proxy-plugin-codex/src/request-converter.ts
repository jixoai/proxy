/**
 * Codex Responses API → Claude Messages API 请求转换器
 */

import type {
  CodexRequest,
  CodexResponseItem,
  CodexTool,
  ClaudeRequest,
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeTool,
  ClaudeThinking,
  ConvertResult,
} from "./types";

import {
  TARGET_MODEL_HEADER,
  EFFORT_TO_BUDGET,
  DEFAULT_BUDGET_TOKENS,
  ANTHROPIC_BETA_FEATURES,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  DEFAULT_USER_ID,
} from "./constants";

/**
 * 检测是否为 Codex 请求
 */
export function isCodexRequest(body: unknown): body is CodexRequest {
  if (!body || typeof body !== "object") return false;
  const req = body as Record<string, unknown>;
  return (
    typeof req.model === "string" &&
    typeof req.instructions === "string" &&
    Array.isArray(req.input)
  );
}

/**
 * 获取目标模型
 * 优先级：header 指定 > 请求中的 model（直接透传）
 * 
 * 注意：模型映射应通过 proxy 配置的 x-target-model header 指定，
 * 代码不做任何硬编码映射，这样新模型只需改配置即可。
 */
export function mapModel(model: string, targetModelFromHeader?: string): string {
  // 优先使用 header 指定的模型
  if (targetModelFromHeader) {
    return targetModelFromHeader;
  }
  // 直接使用请求中的 model（透传）
  return model;
}

/**
 * 从 headers 中提取目标模型
 */
export function extractTargetModel(headers: Record<string, string>): string | undefined {
  const headerName = TARGET_MODEL_HEADER.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === headerName && value) {
      return value;
    }
  }
  return undefined;
}

/** Claude Code 官方身份标识 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** System 文本块类型 */
export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

/**
 * 转换 instructions
 *
 * 为减少对原始请求语义的干预，这里默认不做文本替换，只做轻量 trim。
 */
export function convertInstructions(instructions: string): string {
  return instructions.trim();
}

/**
 * 构建 Claude 格式的 system 数组
 * 
 * 与 proxy-plugin-droid 保持一致:
 * 1. 第一个块: Claude Code 身份标识（短文本，不缓存）
 * 2. 第二个块: 转换后的 instructions（长文本，使用 ephemeral 缓存）
 * 
 * 注意: Claude 限制每个请求最多 4 个 cache breakpoints
 */
export function buildSystemBlocks(instructions: string): SystemBlock[] {
  const convertedInstructions = convertInstructions(instructions);
  
  return [
    {
      type: "text",
      text: CLAUDE_CODE_IDENTITY,
    },
    {
      type: "text",
      text: `<codex-system-context>\n${convertedInstructions}\n</codex-system-context>`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * 转换 reasoning 配置为 thinking 配置
 */
export function convertReasoning(reasoning?: { effort?: string }): ClaudeThinking | undefined {
  if (!reasoning?.effort || reasoning.effort === "none") {
    return undefined;
  }
  const budget = EFFORT_TO_BUDGET[reasoning.effort] ?? DEFAULT_BUDGET_TOKENS;
  if (budget === 0) return undefined;
  return { type: "enabled", budget_tokens: budget };
}

/**
 * 推断 input item 的目标角色
 */
function inferRole(item: CodexResponseItem): "user" | "assistant" {
  switch (item.type) {
    case "message":
      return item.role as "user" | "assistant";
    case "reasoning":
    case "function_call":
    case "custom_tool_call":
    case "web_search_call":
    case "local_shell_call":
    case "compaction":
      return "assistant";
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output":
      return "user";
    case "ghost_snapshot":
      // ghost_snapshot is metadata, treat as user context
      return "user";
    default:
      return "user";
  }
}

/**
 * 转换 ID 格式: call_xxx → toolu_xxx
 */
export function convertCallId(callId: string): string {
  if (callId.startsWith("call_")) {
    return "toolu_" + callId.slice(5);
  }
  return callId;
}

/** 将单个 Codex item 转换为 Claude content block */
function convertToContentBlock(item: CodexResponseItem): ClaudeContentBlock | null {
  switch (item.type) {
    case "message": {
      const textParts = item.content
        .filter((c) => c.type === "input_text" || c.type === "output_text")
        .map((c) => (c as { text: string }).text);
      if (textParts.length === 0) return null;
      return { type: "text", text: textParts.join("\n") };
    }

    case "reasoning": {
      // If no encrypted_content (signature), skip this thinking block
      // Claude requires a valid signature for thinking blocks in multi-turn conversations
      if (!item.encrypted_content) {
        // Fall back to a text block with the reasoning summary
        const thinkingText = item.summary.map((s) => s.text).join("\n");
        if (!thinkingText) return null;
        return {
          type: "text",
          text: `[Reasoning: ${thinkingText}]`,
        };
      }
      
      const thinkingText = item.summary.map((s) => s.text).join("\n");
      return {
        type: "thinking",
        thinking: thinkingText,
        signature: item.encrypted_content,
      };
    }

    case "function_call": {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(item.arguments);
      } catch {
        input = {};
      }

      return {
        type: "tool_use",
        id: convertCallId(item.call_id),
        name: item.name,
        input,
      };
    }

    case "function_call_output": {
      return {
        type: "tool_result",
        tool_use_id: convertCallId(item.call_id),
        content: item.output,
      };
    }

    case "custom_tool_call": {
      return {
        type: "tool_use",
        id: convertCallId(item.call_id),
        name: item.name,
        input: { input: item.input },
      };
    }

    case "custom_tool_call_output": {
      return {
        type: "tool_result",
        tool_use_id: convertCallId(item.call_id),
        content: item.output,
      };
    }

    case "web_search_call": {
      // OpenAI 内置 web_search 不是 Codex CLI 本地可执行工具：
      // 将其转换为文本，保留动作上下文，避免 Claude 生成不可执行的 tool_use。
      const action = item.action as { type?: string; query?: string; url?: string; pattern?: string } | undefined;
      const actionType = action?.type || "search";
      if (actionType === "search") {
        const query = action?.query || "";
        return { type: "text", text: query ? `[web_search] ${query}` : "[web_search]" };
      }
      if (actionType === "open_page") {
        const url = action?.url || "";
        return { type: "text", text: url ? `[web_search.open_page] ${url}` : "[web_search.open_page]" };
      }
      if (actionType === "find_in_page") {
        const url = action?.url || "";
        const pattern = action?.pattern || "";
        return {
          type: "text",
          text: `[web_search.find_in_page] url=${url || "(unknown)"} pattern=${pattern || "(unknown)"}`,
        };
      }

      return { type: "text", text: `[web_search.${actionType}]` };
    }

    case "local_shell_call": {
      const action = item.action;
      const command = action?.command?.join(" ") || "";
      return {
        type: "tool_use",
        id: convertCallId(item.call_id || `call_ls_${Date.now()}`),
        name: "exec_command",
        input: {
          cmd: command,
          ...(action?.timeout_ms ? { yield_time_ms: action.timeout_ms } : {}),
          ...(action?.working_directory ? { workdir: action.working_directory } : {}),
        },
      };
    }

    case "local_shell_call_output": {
      return {
        type: "tool_result",
        tool_use_id: convertCallId(item.call_id),
        content: item.output,
      };
    }

    case "compaction": {
      // Compaction 是压缩后的上下文，包含 encrypted_content
      // 类似于 reasoning，需要保持 signature
      if (!item.encrypted_content) return null;
      return {
        type: "thinking",
        thinking: "[Compacted context]",
        signature: item.encrypted_content,
      };
    }

    case "ghost_snapshot": {
      // Ghost snapshot 是版本控制元数据，可以忽略或转为简单文本
      return null;
    }

    default:
      return null;
  }
}

/**
 * 将 Codex input[] 合并转换为 Claude messages[]
 * 确保 user/assistant 严格交替
 */
export function mergeInputToMessages(input: CodexResponseItem[]): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];
  let current: { role: "user" | "assistant"; content: ClaudeContentBlock[] } | null = null;

  for (const item of input) {
    const role = inferRole(item);
    const block = convertToContentBlock(item);

    if (!block) continue;

    if (!current || current.role !== role) {
      if (current && current.content.length > 0) {
        messages.push(current);
      }
      current = { role, content: [] };
    }

    current.content.push(block);
  }

  if (current && current.content.length > 0) {
    messages.push(current);
  }

  // 确保以 user 消息开头
  const firstMsg = messages[0];
  if (messages.length > 0 && firstMsg && firstMsg.role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(system)" }] });
  }

  return messages;
}

/**
 * 转换工具定义
 */
export function convertTools(tools?: CodexTool[]): ClaudeTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const result: ClaudeTool[] = [];

  for (const tool of tools) {
    if (tool.type === "web_search") {
      // OpenAI 内置 web_search 无法在 Claude Messages API 中作为“本地工具”执行；
      // 为避免 Claude 生成不可执行的 tool_use，这里不向 Claude 暴露该工具。
      continue;
    }

    if (tool.type === "function" && tool.name) {
      result.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.parameters || { type: "object", properties: {}, additionalProperties: false },
      });
      continue;
    }

    if (tool.type === "custom" && tool.name) {
      result.push({
        name: tool.name,
        description: tool.description || "",
        input_schema:
          tool.parameters || {
            type: "object",
            properties: {
              input: { type: "string", description: "Tool input string" },
            },
            required: ["input"],
            additionalProperties: false,
          },
      });
      continue;
    }
  }

  return result.length > 0 ? result : undefined;
}

/** 转换请求选项 */
export interface ConvertRequestOptions {
  /** 从 header 中提取的目标模型（可选） */
  targetModel?: string;
  /** 自定义 user_id（可选，默认使用 DEFAULT_USER_ID） */
  userId?: string;
}

/**
 * 转换完整请求
 * @param codex Codex 请求
 * @param options 转换选项
 */
export function convertRequest(codex: CodexRequest, options: ConvertRequestOptions = {}): ClaudeRequest {
  const { targetModel, userId } = options;
  return {
    model: mapModel(codex.model, targetModel),
    max_tokens: codex.max_output_tokens || DEFAULT_MAX_TOKENS,
    system: buildSystemBlocks(codex.instructions),
    messages: mergeInputToMessages(codex.input),
    tools: convertTools(codex.tools),
    tool_choice:
      codex.tool_choice && codex.tool_choice !== "auto"
        ? { type: "tool", name: codex.tool_choice }
        : undefined,
    thinking: convertReasoning(codex.reasoning),
    stream: codex.stream ?? true,
    metadata: {
      user_id: userId || DEFAULT_USER_ID,
    },
  };
}

/**
 * 转换请求头
 * - 移除 Codex 特有的 headers (会暴露身份)
 * - 添加 Claude Code / Anthropic SDK 特有的 headers
 * - 伪装成 Claude Code 官方请求
 */
export function convertHeaders(headers: Record<string, string>): Record<string, string> {
  const newHeaders: Record<string, string> = {};
  
  // 需要排除的 headers (Codex 特有，会暴露身份)
  const excludeHeaders = new Set([
    TARGET_MODEL_HEADER.toLowerCase(),
    "user-agent",
    "x-app",
    "accept",
    "accept-encoding",
    // Codex 特有 headers - 必须删除
    "conversation_id",
    "originator", 
    "session_id",
    "x-codex-beta-features",
  ]);

  // 复制允许的 headers
  for (const [key, value] of Object.entries(headers)) {
    if (!excludeHeaders.has(key.toLowerCase())) {
      newHeaders[key] = value;
    }
  }

  // 设置 Anthropic 特定头
  newHeaders["anthropic-version"] = ANTHROPIC_VERSION;
  newHeaders["anthropic-beta"] = ANTHROPIC_BETA_FEATURES;
  newHeaders["content-type"] = "application/json";
  newHeaders["accept"] = "application/json";
  newHeaders["accept-encoding"] = "gzip, deflate, br, zstd";

  // Claude Code 必需的 headers
  newHeaders["user-agent"] = "claude-cli/2.0.58 (external, cli)";
  newHeaders["x-app"] = "cli";
  newHeaders["anthropic-dangerous-direct-browser-access"] = "true";

  // x-stainless-* headers (Claude SDK 标识，模拟官方 SDK)
  newHeaders["x-stainless-arch"] = "arm64";
  newHeaders["x-stainless-helper-method"] = "stream";
  newHeaders["x-stainless-lang"] = "js";
  newHeaders["x-stainless-os"] = "MacOS";
  newHeaders["x-stainless-package-version"] = "0.70.0";
  newHeaders["x-stainless-retry-count"] = "0";
  newHeaders["x-stainless-runtime"] = "node";
  newHeaders["x-stainless-runtime-version"] = "v24.3.0";
  newHeaders["x-stainless-timeout"] = "600";

  // 保持 authorization header (不要转换为 x-api-key)
  // 如果没有 authorization 但有 x-api-key，转换回 authorization
  if (!newHeaders["authorization"] && newHeaders["x-api-key"]) {
    newHeaders["authorization"] = `Bearer ${newHeaders["x-api-key"]}`;
    delete newHeaders["x-api-key"];
  }

  return newHeaders;
}

/** 重写请求参数 */
export interface RewriteRequestParams {
  headers: Record<string, string>;
  /** 原始请求体（字符串）或已解析的请求对象 */
  body: string | CodexRequest;
  /** 自定义 user_id（可选） */
  userId?: string;
}

/**
 * 重写整个请求
 * 
 * 模型选择优先级：
 * 1. X-Target-Model header 指定的模型
 * 2. 模型名以 claude- 开头，直接透传
 * 3. 模型映射表
 * 4. 默认模型
 */
export function rewriteRequest(params: RewriteRequestParams): ConvertResult {
  const { headers, body, userId } = params;

  if (!body) return {};

  // 支持传入已解析的对象或字符串
  let requestBody: CodexRequest;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (!isCodexRequest(parsed)) {
        return {};
      }
      requestBody = parsed;
    } catch {
      return {};
    }
  } else {
    requestBody = body;
  }

  // 从 header 提取目标模型
  const targetModel = extractTargetModel(headers);

  // 转换请求
  const claudeRequest = convertRequest(requestBody, { targetModel, userId });

  return {
    headers: convertHeaders(headers),
    body: JSON.stringify(claudeRequest),
  };
}
