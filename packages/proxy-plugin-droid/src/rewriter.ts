/**
 * Droid 请求重写逻辑
 *
 * 将 Droid-CLI 格式的请求转换为 Claude-Code-CLI 格式
 */

import type { RequestBody, Message, TextBlock, RewriteResult } from "./types";

/**
 * 检测是否为 Droid 请求
 */
export function isDroidRequest(requestBody: RequestBody): boolean {
  if (!requestBody.system) return false;

  const systemText = Array.isArray(requestBody.system)
    ? requestBody.system.map((s) => s.text || "").join(" ")
    : String(requestBody.system);

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
  newReminderText: string
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
        c?.type === "text" && typeof c.text === "string" && c.text.includes("<system-reminder>")
    );

    const secondSysTexts = secondContent
      .filter(
        (c) =>
          c?.type === "text" && typeof c.text === "string" && c.text.includes("<system-reminder>")
      )
      .map((c) => c.text);

    if (firstSysIndex !== -1 && secondSysTexts.length > 0) {
      const target = firstContent[firstSysIndex];
      if (target?.text) {
        const replacement = replaceSystemReminderSection(target.text, secondSysTexts.join("\n\n"));
        if (replacement) {
          target.text = replacement;
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
export function rewriteRequestBody(requestBody: RequestBody): RequestBody | null {
  if (!isDroidRequest(requestBody)) {
    return null;
  }

  const droidSystemText = extractSystemText(requestBody.system);

  // 构建 Claude Code 风格的 system
  const claudeCodeSystem: TextBlock[] = [
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
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

  return requestBody;
}

/**
 * 重写请求头
 */
export function rewriteHeaders(headers: Record<string, string>): Record<string, string> {
  const newHeaders: Record<string, string> = { ...headers };

  newHeaders["anthropic-beta"] = "claude-code-20250219,interleaved-thinking-2025-05-14";

  if (newHeaders["x-api-key"] && !newHeaders["authorization"]) {
    newHeaders["authorization"] = `Bearer ${newHeaders["x-api-key"]}`;
    delete newHeaders["x-api-key"];
  }

  newHeaders["x-app"] = "cli";
  newHeaders["anthropic-dangerous-direct-browser-access"] = "true";
  newHeaders["user-agent"] = "claude-cli/2.0.58 (external, cli)";

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
}): RewriteResult {
  const { headers, body } = params;

  if (!body) {
    return {};
  }

  let requestBody: RequestBody;
  try {
    requestBody = JSON.parse(body) as RequestBody;
  } catch {
    return {};
  }

  const rewrittenBody = rewriteRequestBody(requestBody);
  if (!rewrittenBody) {
    return {};
  }

  return {
    headers: rewriteHeaders(headers),
    body: JSON.stringify(rewrittenBody),
  };
}
