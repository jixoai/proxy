/**
 * Claude Messages API → Codex Responses API 请求转换器
 */

import { createHash } from "crypto";
import type {
  ClaudeRequest,
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeSystemBlock,
  ClaudeTool,
  ClaudeToolUseBlock,
  ClaudeToolResultBlock,
  ClaudeThinkingBlock,
  ClaudeTextBlock,
  CodexRequest,
  CodexResponseItem,
  CodexTool,
  CodexContentItem,
  ConvertResult,
} from "./types";

import { getCodexCliInstructions } from "./codex-cli-instructions";

import {
  TARGET_MODEL_HEADER,
  budgetToEffort,
  convertToolIdToCallId,
  isCustomTool,
  isServerTool,
  CODEX_REQUIRED_HEADERS,
  HEADERS_TO_REMOVE,
  APPLY_PATCH_TOOL_FORMAT,
  mapToolNameToCodex,
} from "./constants";

/**
 * 检测是否为 Claude Messages API 请求
 */
export function isClaudeRequest(body: unknown): body is ClaudeRequest {
  if (!body || typeof body !== "object") return false;
  const req = body as Record<string, unknown>;
  return (
    typeof req.model === "string" &&
    Array.isArray(req.messages) &&
    typeof req.max_tokens === "number"
  );
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

function extractSessionIdFromUserId(userId: string): string | null {
  const match = /(?:^|_)session_([0-9a-fA-F-]{36})(?:$|_)/.exec(userId);
  if (match?.[1]) return match[1];

  const hash = createHash("sha256").update(userId).digest("hex");
  // 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function deriveCodexSessionId(claude: ClaudeRequest): string | null {
  const userId = claude.metadata?.user_id;
  if (typeof userId !== "string" || userId.length === 0) return null;
  return extractSessionIdFromUserId(userId);
}

function isPrivateHeaderKey(key: string): boolean {
  return key.toLowerCase().startsWith("-x-jixo-proxy-");
}

function mergeClaudeSystemText(system: string | ClaudeSystemBlock[] | undefined): string {
  if (!system) return "";

  if (typeof system === "string") {
    return system.trim();
  }

  return system
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function extractClaudeCodeContext(systemText: string): string | undefined {
  if (!systemText) return undefined;

  const parts: string[] = [];

  const envMatch = /<env>[\s\S]*?<\/env>/.exec(systemText);
  if (envMatch?.[0]) parts.push(envMatch[0].trim());

  const gitStatusIndex = systemText.indexOf("gitStatus:");
  if (gitStatusIndex >= 0) parts.push(systemText.slice(gitStatusIndex).trim());

  if (parts.length === 0) return undefined;

  return `<claude-code-context>\n${parts.join("\n\n")}\n</claude-code-context>`;
}

/**
 * Claude Code 特有工具使用指导
 *
 * 注意：由于 Codex 后端验证 instructions 字段，我们无法直接修改它。
 * 但可以通过 Responses API 的 developer 角色消息来注入额外指导。
 * developer 消息的优先级低于 instructions，但高于 user 消息。
 */
const CLAUDE_CODE_TOOLS_GUIDANCE = `You have access to several special tools that provide interactive UI features in Claude Code. Use these tools appropriately:

## AskUserQuestion Tool
Use \`AskUserQuestion\` for interactive user input when you need to:
- Gather user preferences or requirements before proceeding
- Clarify ambiguous instructions
- Get decisions on implementation choices
- Present multiple options and let the user choose

**IMPORTANT**: When you need to ask the user questions with multiple-choice options, you MUST use the \`AskUserQuestion\` tool instead of writing questions in plain text. This enables an interactive UI.

## TodoWrite Tool
Use \`TodoWrite\` (Codex side name: \`update_plan\`) to create and manage structured task lists for:
- Complex multi-step tasks (3+ steps)
- When the user provides multiple tasks or a list of requirements
- To track progress on non-trivial work

## EnterPlanMode Tool
Use \`EnterPlanMode\` when starting non-trivial implementation tasks that would benefit from user approval of your approach.

## ExitPlanMode Tool
Use \`ExitPlanMode\` when you have finished writing your implementation plan and are ready for user approval.`;
/**
 * 转换 system 为 instructions
 *
 * 注意：Codex 后端会验证 instructions 格式，只接受空字符串或标准的 Codex CLI 系统提示。
 * 因此我们必须使用预定义的 Codex CLI instructions 模板，并动态替换模型名称。
 *
 * @param system - Claude 的 system 配置（当前被忽略）
 * @param targetModel - 目标模型名称，用于替换 instructions 中的模型标识
 */
export function convertSystemToInstructions(
  system: string | ClaudeSystemBlock[] | undefined,
  targetModel?: string
): string {
  void system;
  // Allow overriding instructions behavior for gateways that accept empty prompts
  // or for experiments to reduce prompt maintenance cost.
  if (process.env.RESPONSES4CLAUDECODE_INSTRUCTIONS_MODE === "empty") {
    return "";
  }
  return getCodexCliInstructions(targetModel);
}

/**
 * 转换 Claude thinking 配置为 Codex reasoning 配置
 * 无论是否有 thinking 配置，都会返回 reasoning（默认 effort: medium）
 */
export function convertThinkingToReasoning(
  thinking?: { type: "enabled"; budget_tokens: number }
): { effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"; summary: "auto" | "detailed" | "none" } {
  // 无 thinking 配置时，默认使用 medium
  if (!thinking || thinking.type !== "enabled") {
    return {
      effort: "medium",
      summary: "auto",
    };
  }
  
  // 有 thinking 配置时，根据 budget_tokens 映射 effort
  const effort = budgetToEffort(thinking.budget_tokens) as "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  return {
    effort: effort === "none" ? "medium" : effort,
    summary: "auto",
  };
}


/**
 * 转换 Claude content block 为 Codex content item
 */
function convertContentBlockToContentItem(
  block: ClaudeContentBlock,
  role: "user" | "assistant"
): CodexContentItem | null {
  if (block.type === "text") {
    return role === "user"
      ? { type: "input_text", text: block.text }
      : { type: "output_text", text: block.text };
  }
  
  if (block.type === "image") {
    const source = block.source;
    let imageUrl: string;
    
    if (source.type === "base64" && source.data && source.media_type) {
      imageUrl = `data:${source.media_type};base64,${source.data}`;
    } else if (source.type === "url" && source.url) {
      imageUrl = source.url;
    } else {
      return null;
    }
    
    return { type: "input_image", image_url: imageUrl };
  }
  
  return null;
}

/**
 * 转换 Claude tool_use 为 Codex function_call 或 custom_tool_call
 */
function convertToolUseToCodex(block: ClaudeToolUseBlock): CodexResponseItem {
  const callId = convertToolIdToCallId(block.id);
  // 映射工具名称（如 TodoWrite → update_plan）
  const codexToolName = mapToolNameToCodex(block.name);

  if (isServerTool(block.name) && block.name === "web_search") {
    const query =
      block.input && typeof (block.input as Record<string, unknown>).query === "string"
        ? ((block.input as Record<string, unknown>).query as string)
        : undefined;

    return {
      type: "web_search_call",
      status: "completed",
      action: query ? { type: "search", query } : { type: "search" },
    };
  }

  if (isCustomTool(block.name)) {
    // custom_tool_call: input 是字符串
    const input = typeof block.input === "string"
      ? block.input
      : (block.input as { input?: string }).input || JSON.stringify(block.input);

    return {
      type: "custom_tool_call",
      name: codexToolName,
      input,
      call_id: callId,
      status: "completed",
    };
  }

  // function_call: arguments 是 JSON 字符串
  return {
    type: "function_call",
    name: codexToolName,
    arguments: JSON.stringify(block.input),
    call_id: callId,
  };
}

/**
 * 转换 Claude tool_result 为 Codex function_call_output 或 custom_tool_call_output
 */
function convertToolResultToCodex(
  block: ClaudeToolResultBlock,
  toolName?: string
): CodexResponseItem {
  const callId = convertToolIdToCallId(block.tool_use_id);
  
  // 获取 output 内容
  let output: string;
  if (typeof block.content === "string") {
    output = block.content;
  } else if (Array.isArray(block.content)) {
    // 合并 content blocks 为字符串
    output = block.content
      .filter((b): b is ClaudeTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    output = "";
  }
  
  // 如果是 error，添加前缀
  if (block.is_error) {
    output = `Error: ${output}`;
  }
  
  // 根据 tool name 决定使用哪种 output 类型
  if (toolName && isCustomTool(toolName)) {
    return {
      type: "custom_tool_call_output",
      call_id: callId,
      output,
    };
  }
  
  return {
    type: "function_call_output",
    call_id: callId,
    output,
  };
}

/**
 * 转换 Claude thinking 为 Codex reasoning
 */
function convertThinkingBlockToCodex(block: ClaudeThinkingBlock): CodexResponseItem {
  return {
    type: "reasoning",
    summary: [
      {
        type: "summary_text",
        text: block.thinking,
      },
    ],
  };
}

/**
 * 转换 Claude messages 为 Codex input
 */
export function convertMessagesToInput(messages: ClaudeMessage[]): CodexResponseItem[] {
  const input: CodexResponseItem[] = [];
  
  // 用于追踪 tool_use 的名称，以便在 tool_result 中使用
  const toolIdToName = new Map<string, string>();
  
  for (const message of messages) {
    const role = message.role;
    const content = message.content;
    
    // 处理字符串 content
    if (typeof content === "string") {
      input.push({
        type: "message",
        role,
        content: [
          role === "user"
            ? { type: "input_text", text: content }
            : { type: "output_text", text: content },
        ],
      });
      continue;
    }
    
    // 处理数组 content
    const contentItems: CodexContentItem[] = [];
    
    for (const block of content) {
      switch (block.type) {
        case "text":
        case "image": {
          const item = convertContentBlockToContentItem(block, role);
          if (item) contentItems.push(item);
          break;
        }
        
        case "thinking": {
          // 先 flush 当前累积的 content
          if (contentItems.length > 0) {
            input.push({
              type: "message",
              role,
              content: [...contentItems],
            });
            contentItems.length = 0;
          }
          // 添加 reasoning item
          input.push(convertThinkingBlockToCodex(block));
          break;
        }
        
        case "tool_use": {
          // 先 flush 当前累积的 content
          if (contentItems.length > 0) {
            input.push({
              type: "message",
              role,
              content: [...contentItems],
            });
            contentItems.length = 0;
          }
          // 记录 tool name
          toolIdToName.set(block.id, block.name);
          // 添加 tool call
          input.push(convertToolUseToCodex(block));
          break;
        }
        
        case "tool_result": {
          // 先 flush 当前累积的 content
          if (contentItems.length > 0) {
            input.push({
              type: "message",
              role,
              content: [...contentItems],
            });
            contentItems.length = 0;
          }
          // 获取对应的 tool name
          const toolName = toolIdToName.get(block.tool_use_id);
          // 添加 tool output
          input.push(convertToolResultToCodex(block, toolName));
          break;
        }
      }
    }
    
    // Flush 剩余的 content items
    if (contentItems.length > 0) {
      input.push({
        type: "message",
        role,
        content: contentItems,
      });
    }
  }
  
  return input;
}

/**
 * 转换 Claude tools 为 Codex tools
 */
export function convertTools(tools?: ClaudeTool[]): CodexTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  
  const result: CodexTool[] = [];

  const normalizeParameters = (schema: Record<string, unknown> | undefined): Record<string, unknown> => {
    if (!schema || typeof schema !== "object") {
      return { type: "object", properties: {}, additionalProperties: false };
    }

    const asObj = schema as Record<string, unknown>;
    if (asObj.type === "object" && !("additionalProperties" in asObj)) {
      return { ...asObj, additionalProperties: false };
    }

    return asObj;
  };
  
  for (const tool of tools) {
    // Server-side tool (如 web_search)
    if ("type" in tool && typeof tool.type === "string") {
      if (tool.type.startsWith("web_search")) {
        result.push({
          type: "web_search",
        });
        continue;
      }
      // 其他 server tools 暂时跳过
      continue;
    }
    
    // Client tool
    const clientTool = tool as { name: string; description: string; input_schema: Record<string, unknown> };

    // 映射工具名称（如 TodoWrite → update_plan）
    const codexToolName = mapToolNameToCodex(clientTool.name);

    if (clientTool.name === "apply_patch") {
      result.push({
        type: "custom",
        name: codexToolName,
        description: clientTool.description,
        format: APPLY_PATCH_TOOL_FORMAT,
      });
    } else {
      result.push({
        type: "function",
        name: codexToolName,
        description: clientTool.description,
        strict: false,
        parameters: normalizeParameters(clientTool.input_schema),
      });
    }
  }
  
  return result.length > 0 ? result : undefined;
}

/**
 * 转换 tool_choice
 */
export function convertToolChoice(
  toolChoice?: { type: string } | { type: "tool"; name: string }
): string | undefined {
  if (!toolChoice) return undefined;
  
  if (toolChoice.type === "auto") {
    return "auto";
  }
  
  if (toolChoice.type === "any") {
    return "required";
  }
  
  return undefined;
}

/**
 * 转换完整的 Claude 请求为 Codex 请求
 */
export function convertRequest(
  claude: ClaudeRequest,
  options: { targetModel?: string; promptCacheKey?: string | null } = {}
): CodexRequest {
  const { targetModel, promptCacheKey } = options;
  let tools = convertTools(claude.tools);

  const forcedToolName =
    claude.tool_choice && typeof claude.tool_choice === "object" && "type" in claude.tool_choice
      ? (claude.tool_choice as { type: string; name?: string }).type === "tool"
        ? (claude.tool_choice as { type: "tool"; name: string }).name
        : undefined
      : undefined;

  // Some Codex-compatible backends only accept tool_choice as: "none" | "auto" | "required".
  // To support Claude's { type: "tool", name }, we degrade to tool_choice="required" and
  // restrict the tool list to the requested tool when possible.
  // 注意：工具名称可能已被映射（如 TodoWrite → update_plan），所以需要同时检查映射后的名称
  const isRequestedTool = (tool: CodexTool, claudeName: string): boolean => {
    const mappedName = mapToolNameToCodex(claudeName);
    if ("name" in tool && typeof tool.name === "string") {
      // 检查原始名称或映射后的名称
      if (tool.name === claudeName || tool.name === mappedName) return true;
    }
    if (tool.type === "web_search" && claudeName === "web_search") return true;
    return false;
  };

  if (forcedToolName && tools && tools.length > 0) {
    const filtered = tools.filter((t) => isRequestedTool(t, forcedToolName));
    if (filtered.length > 0) tools = filtered;
  }

  const toolChoice =
    forcedToolName && tools && tools.length > 0
      ? "required"
      : (convertToolChoice(claude.tool_choice) ?? (tools && tools.length > 0 ? "auto" : undefined));

  const input = convertMessagesToInput(claude.messages);
  const systemText = mergeClaudeSystemText(claude.system);
  const context = extractClaudeCodeContext(systemText);

  // 注入 Claude Code 工具指导作为 developer 消息
  // developer 角色类似于 Chat Completions 的 system 角色
  // 优先级：instructions > developer > user
  if (tools && tools.length > 0) {
    input.unshift({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: CLAUDE_CODE_TOOLS_GUIDANCE }],
    });
  }

  // 注入 Claude Code 上下文作为 user 消息
  if (context) {
    input.unshift({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: context }],
    });
  }
  
  // 计算最终的模型名称
  const finalModel = mapModel(claude.model, targetModel);

  return {
    model: finalModel,
    instructions: convertSystemToInstructions(claude.system, finalModel),
    input,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: tools && tools.length > 0 ? true : undefined,
    reasoning: convertThinkingToReasoning(claude.thinking),
    store: false,
    include: ["reasoning.encrypted_content"],
    // NOTE: 禁用 prompt_cache_key 以确保 Codex 报告完整的 input_tokens
    // 当启用 prompt caching 时，Codex 只报告新增的 token（不是缓存的）
    // 这导致 Claude Code 无法正确判断上下文大小，无法触发摘要压缩
    // prompt_cache_key: promptCacheKey || undefined,
    text: { verbosity: "low" },
    stream: claude.stream ?? true,
    // Note: max_output_tokens was removed from Codex API (see changelog: "drop model_max_output_tokens")
  };
}

/**
 * 转换请求 headers
 */
export function convertHeaders(
  headers: Record<string, string>,
  options: { stream?: boolean; sessionId?: string | null } = {}
): Record<string, string> {
  const newHeaders: Record<string, string> = {};
  const stream = options.stream ?? true;
  const sessionId = options.sessionId;

  // 复制允许的 headers
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (isPrivateHeaderKey(lowerKey)) continue;
    if (HEADERS_TO_REMOVE.has(lowerKey)) continue;

    newHeaders[lowerKey] = value;
  }

  // 必需 headers
  Object.assign(newHeaders, CODEX_REQUIRED_HEADERS);
  newHeaders["accept"] = stream ? "text/event-stream" : "application/json";

  // Align with Codex CLI identity headers (helps some gateways/tooling).
  newHeaders["originator"] = "codex_cli_rs";
  newHeaders["x-codex-beta-features"] = "unified_exec,shell_snapshot";
  newHeaders["user-agent"] = "codex_cli_rs";
  if (sessionId) {
    newHeaders["session_id"] = sessionId;
    newHeaders["conversation_id"] = sessionId;
  }

  // 处理 authorization: 如果是 Bearer 格式，保持不变
  // 如果使用 x-api-key，转换为 authorization
  if (!newHeaders["authorization"] && newHeaders["x-api-key"]) {
    newHeaders["authorization"] = `Bearer ${newHeaders["x-api-key"]}`;
    delete newHeaders["x-api-key"];
  }

  return newHeaders;
}

/**
 * 重写整个请求
 */
export function rewriteRequest(params: {
  headers: Record<string, string>;
  body: string | ClaudeRequest;
}): ConvertResult {
  const { headers, body } = params;
  
  if (!body) return {};
  
  // 解析请求体
  let requestBody: ClaudeRequest;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (!isClaudeRequest(parsed)) {
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
  const sessionId = deriveCodexSessionId(requestBody);
  
  // 转换请求
  const codexRequest = convertRequest(requestBody, { targetModel, promptCacheKey: sessionId });
  
  return {
    headers: convertHeaders(headers, { stream: codexRequest.stream, sessionId }),
    body: JSON.stringify(codexRequest),
  };
}
