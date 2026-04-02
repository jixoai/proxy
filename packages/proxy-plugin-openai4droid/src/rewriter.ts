/**
 * Droid 请求重写逻辑
 *
 * 将 Droid 格式的 OpenAI Responses API 请求转换为标准 Codex CLI 格式
 */

import { createHash } from "node:crypto";
import type { RequestBody, RewriteResult, AnyTool } from "./types";
import { isWebSearchTool } from "./types";
import { CODEX_INSTRUCTIONS } from "./constants";

/**
 * 检测请求是否包含 web_search 工具
 */
export function hasWebSearchTool(requestBody: RequestBody): boolean {
  if (!requestBody.tools || !Array.isArray(requestBody.tools)) return false;
  return requestBody.tools.some((tool) => isWebSearchTool(tool));
}

/**
 * 检测是否为 Droid 请求
 */
export function isDroidRequest(requestBody: RequestBody): boolean {
  if (!requestBody.instructions) return false;
  return requestBody.instructions.startsWith(
    "You are Droid, an AI software engineering agent built by Factory.",
  );
}

/**
 * 检测是否为需要处理的 websearch 请求
 * - 包含 web_search 工具
 * - instructions 不是完整的 CODEX_INSTRUCTIONS（通过长度判断）
 */
export function isWebSearchRequest(requestBody: RequestBody): boolean {
  if (!hasWebSearchTool(requestBody)) return false;
  // 完整的 CODEX_INSTRUCTIONS 长度约 11KB
  // 如果 instructions 长度足够长（> 5000），认为已经是完整的
  if (requestBody.instructions && requestBody.instructions.length > 5000) {
    return false;
  }
  return true;
}

/**
 * 检测是否为 Droid 的原生 summarizer/compact 请求
 *
 * 这类请求本身已经是标准 OpenAI Responses 形状：
 * - `input` 是单个大字符串
 * - 没有 tools
 * - 通常带 `max_output_tokens`
 * - 非 streaming
 *
 * 对这类请求继续套用 Codex 风格重写会把 summarizer prompt 再次注入到 input 中，
 * 并替换成巨大的 CODEX_INSTRUCTIONS，容易显著拖慢上游处理。
 */
export function isNativeSummarizerRequest(requestBody: RequestBody & { max_output_tokens?: number }): boolean {
  return (
    typeof requestBody.input === "string" &&
    typeof requestBody.instructions === "string" &&
    (!Array.isArray(requestBody.tools) || requestBody.tools.length === 0) &&
    typeof requestBody.max_output_tokens === "number" &&
    requestBody.stream !== true
  );
}

function buildCompactionRequest(requestBody: RequestBody & { max_output_tokens?: number }): RequestBody {
  // Preserve Droid's native summarizer request shape, but switch to SSE so the
  // proxy can observe progress and keep the downstream connection alive while
  // aggregating the final JSON response back for Droid.
  const cloned = structuredClone(requestBody);
  cloned.stream = true;
  return cloned;
}

/**
 * 将 SHA256 字符串转换为稳定的 UUID
 */
function sha256ToStableUuid(sha256Hex: string): string {
  const hex = sha256Hex.replace(/[^a-fA-F0-9]/g, "").toLowerCase();

  if (hex.length < 32) {
    throw new Error("输入字符串长度不足，无法生成 UUID");
  }

  let p1 = hex.substring(0, 8);
  let p2 = hex.substring(8, 12);
  let p3 = hex.substring(12, 16);
  let p4 = hex.substring(16, 20);
  let p5 = hex.substring(20, 32);

  const version = "8";
  p3 = version + p3.substring(1);

  const variant = "9";
  p4 = variant + p4.substring(1);

  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/**
 * 生成 session ID
 */
function generateSessionId(input: string): string {
  const sessionHash = createHash("sha256").update(input).digest("hex");
  return sha256ToStableUuid(sessionHash);
}

/**
 * 重写请求体
 */
export function rewriteRequestBody(requestBody: RequestBody): RequestBody | null {
  const isDroid = isDroidRequest(requestBody);
  const isWebSearch = isWebSearchRequest(requestBody);

  // 既不是 Droid 请求也不是 websearch 请求，不处理
  if (!isDroid && !isWebSearch) {
    return null;
  }

  // Droid 的 compaction/summarizer 请求本身就是合法的 OpenAI Responses 请求。
  // 保持原样，仅在外层补 session headers 即可。
  if (isNativeSummarizerRequest(requestBody as RequestBody & { max_output_tokens?: number })) {
    return buildCompactionRequest(requestBody as RequestBody & { max_output_tokens?: number });
  }

  // 移除 max_output_tokens（Codex API 不支持）
  const { max_output_tokens: _, ...safeRequestBody } = requestBody as RequestBody & {
    max_output_tokens?: number;
  };

  // Droid 请求：将 Droid instructions 注入到 input 中
  let rewriteInput = structuredClone(requestBody.input);
  const droidInstructions = requestBody.instructions;
  if (!droidInstructions) {
    return null;
  }
  if (typeof requestBody.input === "string") {
    rewriteInput = `IMPORTANT:<system>${droidInstructions}</system>\n\n${requestBody.input}`;
  } else if (Array.isArray(requestBody.input) && requestBody.input.length > 0) {
    const firstItem = requestBody.input[0] as unknown as Record<string, unknown>;
    if (firstItem && "content" in firstItem && Array.isArray(firstItem.content)) {
      const content = firstItem.content as Array<Record<string, unknown>>;
      const firstContent = content[0];
      if (firstContent && "text" in firstContent && typeof firstContent.text === "string") {
        const rewriteInputArr = rewriteInput as unknown as Array<Record<string, unknown>>;
        const rewriteFirstItem = rewriteInputArr[0] as Record<string, unknown>;
        const rewriteContent = rewriteFirstItem.content as Array<Record<string, unknown>>;
        rewriteContent[0] = {
          ...firstContent,
          text: `IMPORTANT:<system>${droidInstructions}</system>\n\n${firstContent.text}`,
        };
      }
    }
  }

  return {
    ...safeRequestBody,
    input: rewriteInput,
    instructions: CODEX_INSTRUCTIONS,
  };
}

/**
 * 重写请求头
 */
export function rewriteHeaders(
  headers: Record<string, string>,
  options?: { sessionId?: string; hasWebSearch?: boolean },
): Record<string, string> {
  const newHeaders: Record<string, string> = { ...headers };

  if (options?.sessionId) {
    newHeaders["conversation_id"] = options.sessionId;
    newHeaders["session_id"] = options.sessionId;
  }

  newHeaders["user-agent"] = "codex_cli_rs/0.77.0 (Mac OS 26.2.0; arm64)";
  newHeaders["originator"] = "codex_cli_rs";

  // OpenAI Responses API 的 web_search 不需要特殊 header
  // 但保留这个选项以便将来扩展

  return newHeaders;
}

/**
 * 重写整个请求
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

  // 检测是否包含 web_search 工具
  const hasWebSearch = hasWebSearchTool(requestBody);

  // 生成 session ID
  let sessionInput: string;
  if (typeof requestBody.input === "string") {
    sessionInput = requestBody.input;
  } else if (Array.isArray(rewrittenBody.input) && rewrittenBody.input.length > 0) {
    const firstItem = rewrittenBody.input[0] as unknown as Record<string, unknown>;
    if (firstItem && "content" in firstItem && Array.isArray(firstItem.content)) {
      const content = firstItem.content as Array<Record<string, unknown>>;
      const firstContent = content[0];
      sessionInput =
        firstContent && "text" in firstContent && typeof firstContent.text === "string"
          ? firstContent.text
          : "";
    } else {
      sessionInput = "";
    }
  } else {
    sessionInput = "";
  }

  const sessionId = generateSessionId(sessionInput);

  return {
    headers: rewriteHeaders(headers, { sessionId, hasWebSearch }),
    body: JSON.stringify(rewrittenBody),
  };
}
