/**
 * Droid 请求重写逻辑
 *
 * 将 Droid-CLI 格式的请求转换为 Claude-Code-CLI 格式
 */

import type { RequestBody, Message, TextBlock, RewriteResult, AnyTool } from "./types";
import { isWebSearchTool } from "./types";

export type ModelRewriteConfig = string | Record<string, string>;

/** 默认的 anthropic-beta features */
const DEFAULT_BETAS = [
  "claude-code-20250219",
  "context-1m-2025-08-07",
  "interleaved-thinking-2025-05-14",
  "effort-2025-11-24",
];
const DEFAULT_CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.86 (external, cli)";
const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id";
const SESSION_ID_PATTERN = /session_([0-9a-fA-F-]{36})/;

export type DroidRewriteConfig = {
  model?: ModelRewriteConfig;
  /** anthropic-beta header 值，默认 Claude Code betas + context-1m-2025-08-07 */
  betas?: string[];
};

const DEFAULT_MODEL_REWRITE: Record<string, string> = {};

function splitHeaderValues(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeHeaderFeatures(...groups: Array<string[] | undefined>): string[] {
  const features: string[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const feature of group ?? []) {
      if (seen.has(feature)) continue;
      seen.add(feature);
      features.push(feature);
    }
  }

  return features;
}

function extractSessionIdFromMetadata(metadata: RequestBody["metadata"]): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const userId = metadata["user_id"];
  if (typeof userId !== "string" || !userId) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown };
    if (typeof parsed?.session_id === "string" && parsed.session_id) {
      return parsed.session_id;
    }
  } catch {
    // Ignore non-JSON user_id payloads and fall back to the legacy pattern.
  }

  return userId.match(SESSION_ID_PATTERN)?.[1];
}

function extractClaudeCodeSessionId(
  headers: Record<string, string>,
  requestBody: RequestBody,
): string | undefined {
  const existingHeader = headers[CLAUDE_CODE_SESSION_HEADER];
  if (existingHeader) {
    return existingHeader;
  }

  return extractSessionIdFromMetadata(requestBody.metadata);
}

function resolveClaudeCodeSessionId(
  headers: Record<string, string>,
  requestBody: RequestBody,
): string {
  return extractClaudeCodeSessionId(headers, requestBody) ?? crypto.randomUUID();
}

function rewriteRequestUrl(
  url: string | undefined,
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!url || !headers) {
    return url;
  }

  const betaHeader = headers["anthropic-beta"]?.trim();
  if (!betaHeader) {
    return url;
  }

  try {
    const nextUrl = new URL(url);
    if (!nextUrl.searchParams.has("beta")) {
      nextUrl.searchParams.set("beta", "true");
    }
    return nextUrl.toString();
  } catch {
    return url;
  }
}

function parseRegexRule(pattern: string): RegExp | null {
  if (!pattern.startsWith("/")) return null;
  const lastSlash = pattern.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const source = pattern.slice(1, lastSlash);
  const flags = pattern.slice(lastSlash + 1);
  if (!source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function rewriteModel(model: string | undefined, config?: ModelRewriteConfig): string | undefined {
  if (!model) return model;

  const effectiveConfig = config ?? DEFAULT_MODEL_REWRITE;
  if (typeof effectiveConfig === "string") {
    return effectiveConfig;
  }

  for (const [pattern, replacement] of Object.entries(effectiveConfig)) {
    if (pattern === "*") {
      return replacement;
    }

    const regex = parseRegexRule(pattern);
    if (regex) {
      if (regex.test(model)) {
        return model.replace(regex, replacement);
      }
      continue;
    }

    if (model === pattern) {
      return replacement;
    }
  }

  return model;
}

/**
 * 检测请求是否包含 web_search 工具
 */
export function hasWebSearchTool(requestBody: RequestBody): boolean {
  if (!requestBody.tools || !Array.isArray(requestBody.tools)) return false;
  return requestBody.tools.some((tool) => isWebSearchTool(tool));
}

/**
 * 检测是否为 Droid 的原生 compaction/summarizer 请求
 *
 * 这类请求本身已经是 Anthropic Messages API 的合法形状：
 * - max_tokens 固定为 4000
 * - 只有一条 user 消息
 * - 不带 tools
 * - 不带 thinking
 */
export function isNativeCompactionRequest(
  requestBody: RequestBody & { thinking?: unknown },
): boolean {
  const hasSingleUserMessage =
    Array.isArray(requestBody.messages) &&
    requestBody.messages.length === 1 &&
    requestBody.messages[0]?.role === "user";
  const hasNoTools = !Array.isArray(requestBody.tools) || requestBody.tools.length === 0;
  const hasNoThinking = requestBody.thinking == null;

  return requestBody.max_tokens === 4000 && hasSingleUserMessage && hasNoTools && hasNoThinking;
}

/**
 * 检测是否为 Droid 请求
 *
 * 注意：如果请求已经被处理过（包含 <droid-system-context>），则返回 false
 */
export function isDroidRequest(requestBody: RequestBody): boolean {
  // 如果包含 web_search 工具，也视为需要处理的请求
  if (hasWebSearchTool(requestBody)) {
    // 检查是否已经被处理过
    const systemText = extractSystemText(requestBody.system);
    if (systemText.includes("<droid-system-context>")) {
      return false;
    }
    return true;
  }

  if (!requestBody.system) return false;

  const systemText = Array.isArray(requestBody.system)
    ? requestBody.system.map((s) => s.text || "").join(" ")
    : String(requestBody.system);

  // 如果已经被处理过（包含重写后的标记），跳过
  if (systemText.includes("<droid-system-context>")) {
    return false;
  }

  return (
    systemText.includes("Droid") ||
    systemText.includes("Factory") ||
    systemText.includes("factory-droid")
  );
}

/**
 * 提取 system 文本
 */
export function extractSystemText(system: RequestBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((s) => ("text" in s ? s.text || "" : "")).join("\n\n");
}

/**
 * 将 message.content 标准化为数组格式
 */
export function normalizeContentArray(message: Message | undefined): void {
  if (!message) return;
  if (Array.isArray(message.content)) return;
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: message.content }];
    return;
  }
  message.content = [];
}

/**
 * 替换 system-reminder 部分
 */
export function replaceSystemReminderSection(
  originalText: string,
  newReminderText: string,
): string | null {
  const startTag = "<system-reminder>";
  const endTag = "</system-reminder>";
  const start = originalText.indexOf(startTag);
  const end = originalText.lastIndexOf(endTag);
  if (start === -1 || end === -1 || end <= start) return null;

  const before = originalText.slice(0, start);
  const after = originalText.slice(end + endTag.length);
  return `${before}${newReminderText}${after}`;
}

/**
 * 合并重复的 system-reminder
 *
 * 当连续两条 user 消息都包含 system-reminder 时，
 * 将后一条的 system-reminder 内容合并到前一条中
 */
export function mergeDuplicateSystemReminders(messages: Message[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  let merged = false;
  let i = 0;
  while (i < messages.length - 1) {
    const first = messages[i];
    const second = messages[i + 1];
    if (first?.role !== "user" || second?.role !== "user") {
      i += 1;
      continue;
    }

    normalizeContentArray(first);
    normalizeContentArray(second);

    const firstContent = Array.isArray(first.content) ? first.content : undefined;
    const secondContent = Array.isArray(second.content) ? second.content : undefined;
    if (!firstContent || !secondContent) {
      i += 1;
      continue;
    }

    const firstSysIndex = firstContent.findIndex(
      (c) =>
        c?.type === "text" && typeof c.text === "string" && c.text.includes("<system-reminder>"),
    );

    const secondSysTexts = secondContent
      .filter(
        (c): c is { type: "text"; text: string } =>
          c?.type === "text" &&
          typeof (c as any).text === "string" &&
          (c as any).text.includes("<system-reminder>"),
      )
      .map((c) => c.text);

    if (firstSysIndex !== -1 && secondSysTexts.length > 0) {
      const target = firstContent[firstSysIndex] as { type: "text"; text: string } | undefined;
      if (target?.text) {
        const replacement = replaceSystemReminderSection(target.text, secondSysTexts.join("\n\n"));
        if (replacement) {
          (target as any).text = replacement;
          messages.splice(i + 1, 1);
          merged = true;
          continue;
        }
      }
    }

    i += 1;
  }
  return merged;
}

/**
 * 重写请求体
 *
 * @returns 重写后的请求体，如果无需重写则返回 null
 */
export function rewriteRequestBody(
  requestBody: RequestBody,
  config: DroidRewriteConfig = {},
): RequestBody | null {
  if (!isDroidRequest(requestBody)) {
    return null;
  }

  requestBody.model = rewriteModel(requestBody.model, config.model);

  if (isNativeCompactionRequest(requestBody)) {
    return requestBody;
  }

  const droidSystemText = extractSystemText(requestBody.system);

  // 构建 Claude Code 风格的 system
  const claudeCodeSystem: TextBlock[] = [
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `<droid-system-context>\n${droidSystemText}\n</droid-system-context>`,
      cache_control: { type: "ephemeral" },
    },
  ];
  requestBody.system = claudeCodeSystem;

  // 合并重复的 system-reminder
  mergeDuplicateSystemReminders(requestBody.messages);

  // 确保有 metadata
  if (!requestBody.metadata) {
    requestBody.metadata = {
      user_id:
        "user_8affcbe039c1380bd8de140015ef63dd4936d02ecd7d5a0f78af6ed95967c5c0_account__session_dffce60e-e7a0-4bc3-b847-4e25f13d3c66",
    };
  }

  /// 遍历 messages，对非法的 thinking 做改装
  for (const msg of requestBody.messages ?? []) {
    if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "thinking" && typeof part.signature === "string") {
            if (part.signature.startsWith("{")) {
              msg.content[msg.content.indexOf(part)] = {
                type: "text",
                text: `<thinking>${part.thinking}</thinking>`,
              };
            }
          }
        }
      }
    }
  }

  // web_search 工具会自动保留在 tools 数组中，无需特殊处理
  // Claude Code 格式支持 web_search_20250305 server tool

  return requestBody;
}

/**
 * 重写请求头
 *
 * @param headers - 原始请求头
 * @param options - 可选配置
 * @param options.hasWebSearch - 是否包含 web_search 工具
 * @param options.betas - 自定义 anthropic-beta features
 */
export function rewriteHeaders(
  headers: Record<string, string>,
  options?: { hasWebSearch?: boolean; betas?: string[]; sessionId?: string },
): Record<string, string> {
  const newHeaders: Record<string, string> = { ...headers };

  const incomingBetas = splitHeaderValues(newHeaders["anthropic-beta"]);
  const configuredBetas = options && "betas" in options ? options.betas : undefined;
  const betaFeatures = mergeHeaderFeatures(configuredBetas ?? DEFAULT_BETAS, incomingBetas);

  // 如果包含 web_search 工具，添加 web-search-2025-03-05 beta
  if (options?.hasWebSearch && !betaFeatures.includes("web-search-2025-03-05")) {
    betaFeatures.push("web-search-2025-03-05");
  }

  newHeaders["anthropic-beta"] = betaFeatures.join(",");

  if (newHeaders["x-api-key"] && !newHeaders["authorization"]) {
    newHeaders["authorization"] = `Bearer ${newHeaders["x-api-key"]}`;
    delete newHeaders["x-api-key"];
  }

  newHeaders["x-app"] = "cli";
  newHeaders["anthropic-dangerous-direct-browser-access"] = "true";
  newHeaders["user-agent"] = DEFAULT_CLAUDE_CODE_USER_AGENT;
  if (options?.sessionId) {
    newHeaders[CLAUDE_CODE_SESSION_HEADER] = options.sessionId;
  }

  return newHeaders;
}

/**
 * 重写整个请求
 *
 * @returns 重写结果，如果无需重写则返回空对象
 */
export function rewriteRequest(params: {
  headers: Record<string, string>;
  body: string;
  url?: string;
  config?: DroidRewriteConfig;
}): RewriteResult {
  const { headers, body, url, config } = params;

  if (!body) {
    return {};
  }

  let requestBody: RequestBody;
  try {
    requestBody = JSON.parse(body) as RequestBody;
  } catch {
    return {};
  }

  // 检测是否包含 web_search 工具（在重写前检测）
  const hasWebSearch = hasWebSearchTool(requestBody);
  const isCompactionRequest = isNativeCompactionRequest(requestBody);

  const rewrittenBody = rewriteRequestBody(requestBody, config);
  if (!rewrittenBody) {
    return {};
  }

  const betas = config?.betas;

  const rewrittenHeaders = rewriteHeaders(headers, {
    hasWebSearch,
    betas,
    sessionId: isCompactionRequest
      ? extractClaudeCodeSessionId(headers, rewrittenBody)
      : resolveClaudeCodeSessionId(headers, rewrittenBody),
  });

  return {
    headers: rewrittenHeaders,
    body: JSON.stringify(rewrittenBody),
    url: rewriteRequestUrl(url, rewrittenHeaders),
  };
}
