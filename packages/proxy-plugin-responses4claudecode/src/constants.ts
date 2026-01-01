/**
 * Claude → Codex 转换器常量
 */

/** 目标模型 header 名称 */
export const TARGET_MODEL_HEADER = "x-target-model";

/** Claude thinking budget → Codex reasoning effort 映射 */
export const BUDGET_TO_EFFORT: Record<number, string> = {
  0: "none",
  1024: "minimal",
  2048: "low",
  4096: "medium",
  8192: "high",
  10240: "high",
  16384: "xhigh",
  32768: "xhigh",
};

/**
 * 根据 budget_tokens 获取 effort 级别
 */
export function budgetToEffort(budget: number): string {
  // 找到最接近的 budget 值
  const budgets = Object.keys(BUDGET_TO_EFFORT)
    .map(Number)
    .sort((a, b) => a - b);
  
  for (let i = budgets.length - 1; i >= 0; i--) {
    if (budget >= budgets[i]!) {
      return BUDGET_TO_EFFORT[budgets[i]!]!;
    }
  }
  return "none";
}

/** 自定义工具名称列表（使用 custom_tool_call 而非 function_call） */
export const CUSTOM_TOOL_NAMES = new Set([
  "apply_patch",
]);

/** Server-side 工具名称列表 */
export const SERVER_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
]);

export const APPLY_PATCH_TOOL_FORMAT = {
  type: "grammar",
  syntax: "lark",
  definition: `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`,
} as const;

/**
 * 检查是否为自定义工具
 */
export function isCustomTool(name: string): boolean {
  return CUSTOM_TOOL_NAMES.has(name);
}

/**
 * 检查是否为 server-side 工具
 */
export function isServerTool(name: string): boolean {
  return SERVER_TOOL_NAMES.has(name);
}

/**
 * 转换 Claude tool ID (toolu_xxx) → Codex call ID (call_xxx)
 */
export function convertToolIdToCallId(toolId: string): string {
  if (toolId.startsWith("toolu_")) {
    return "call_" + toolId.slice(6);
  }
  return "call_" + toolId;
}

/**
 * 转换 Codex call ID (call_xxx) → Claude tool ID (toolu_xxx)
 */
export function convertCallIdToToolId(callId: string): string {
  if (callId.startsWith("call_")) {
    return "toolu_" + callId.slice(5);
  }
  return "toolu_" + callId;
}

/**
 * 转换 Codex response ID (resp_xxx) → Claude message ID (msg_xxx)
 */
export function convertResponseIdToMessageId(respId: string): string {
  if (respId.startsWith("resp_")) {
    return "msg_" + respId.slice(5);
  }
  return "msg_" + respId;
}

/** Codex 请求必需的 headers */
export const CODEX_REQUIRED_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "accept": "text/event-stream",
};

/** 需要从 Claude 请求中移除的 headers */
export const HEADERS_TO_REMOVE = new Set([
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  // Keep SSE uncompressed and align with Codex CLI.
  "accept-encoding",
  "x-stainless-arch",
  "x-stainless-helper-method",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
  "x-app",
  // Proxy-config only; model already in request body.
  "x-target-model",
]);

/**
 * 工具名称映射：Claude → Codex
 * Codex CLI 的 instructions 中提到使用 update_plan，但 Claude Code 发送 TodoWrite
 */
export const TOOL_NAME_CLAUDE_TO_CODEX: Record<string, string> = {
  "TodoWrite": "update_plan",
};

/**
 * 工具名称映射：Codex → Claude（反向映射）
 */
export const TOOL_NAME_CODEX_TO_CLAUDE: Record<string, string> = {
  "update_plan": "TodoWrite",
};

/**
 * 将 Claude 工具名称映射为 Codex 工具名称
 */
export function mapToolNameToCodex(claudeToolName: string): string {
  return TOOL_NAME_CLAUDE_TO_CODEX[claudeToolName] ?? claudeToolName;
}

/**
 * 将 Codex 工具名称映射为 Claude 工具名称
 */
export function mapToolNameToClaude(codexToolName: string): string {
  return TOOL_NAME_CODEX_TO_CLAUDE[codexToolName] ?? codexToolName;
}
