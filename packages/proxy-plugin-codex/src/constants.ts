/**
 * 转换常量
 */

/** 自定义 header 名称，用于指定目标 Claude 模型 */
export const TARGET_MODEL_HEADER = "x-target-model";

/** Reasoning effort 到 thinking budget_tokens 映射 */
export const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0,
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 24576,
  xhigh: 32768,
};

/** 默认 budget tokens */
export const DEFAULT_BUDGET_TOKENS = 16384;

/** 工具名映射: Codex → Claude */
export const TOOL_NAME_TO_CLAUDE: Record<string, string> = {
  exec_command: "Bash",
  shell_command: "Bash",
  apply_patch: "FileEdit",
  web_search: "WebSearch",
  view_image: "Read",
};

/** 工具名映射: Claude → Codex */
export const TOOL_NAME_TO_CODEX: Record<string, string> = {
  Bash: "exec_command",
  Execute: "exec_command",
  FileEdit: "apply_patch",
  Edit: "apply_patch",
  MultiEdit: "apply_patch",
  Create: "apply_patch",
  FileRead: "exec_command",
  Read: "exec_command",
  FileWrite: "apply_patch",
  Glob: "exec_command",
  Grep: "exec_command",
  LS: "exec_command",
  WebSearch: "web_search",
  WebFetch: "exec_command",
  TodoWrite: "exec_command",
};

/** Stop reason 映射: Claude → Codex */
export const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  stop_sequence: "stop",
};

/** Anthropic API beta 特性 (顺序与 droid 保持一致: claude-code 在前) */
export const ANTHROPIC_BETA_FEATURES = "claude-code-20250219,interleaved-thinking-2025-05-14";

/** Anthropic API 版本 */
export const ANTHROPIC_VERSION = "2023-06-01";

/** 默认 max tokens */
export const DEFAULT_MAX_TOKENS = 32000;

/** 默认 metadata.user_id（与 Claude Code 保持一致） */
export const DEFAULT_USER_ID = "user_8affcbe039c1380bd8de140015ef63dd4936d02ecd7d5a0f78af6ed95967c5c0_account__session_dffce60e-e7a0-4bc3-b847-4e25f13d3c66";

/**
 * 生成唯一 ID
 * @param prefix ID 前缀 (如 "fc_", "rs_", "msg_", "toolu_ws_")
 */
export function generateId(prefix: string): string {
  return `${prefix}${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}
