/**
 * count_tokens 端点处理
 *
 * Codex API 没有 count_tokens 端点，因此我们在插件中模拟这个功能。
 * 使用 tiktoken 库计算 token 数量，提供准确的 token 计数。
 *
 * 注意：Claude 使用的 tokenizer 与 OpenAI 不完全相同，但 cl100k_base
 * 编码（GPT-4 使用）提供了足够接近的估算。
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { ClaudeMessage, ClaudeContentBlock } from "./types";

// 使用 cl100k_base 编码（GPT-4 使用的编码，与 Claude 最接近）
let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = getEncoding("cl100k_base");
  }
  return encoder;
}

/**
 * 使用 tiktoken 计算文本的 token 数量
 */
function countTextTokens(text: string): number {
  if (!text) return 0;
  try {
    return getEncoder().encode(text).length;
  } catch {
    // 降级到简单估算
    return Math.ceil(text.length / 4);
  }
}

/**
 * 计算 content block 的 token 数量
 */
function countBlockTokens(block: ClaudeContentBlock): number {
  switch (block.type) {
    case "text":
      return countTextTokens(block.text);

    case "image":
      // 图像 token 计算较复杂，使用固定估算值
      // 根据 Claude 文档，一张图片约 1000-2000 tokens
      return 1500;

    case "tool_use":
      // tool_use: name + input JSON
      return (
        countTextTokens(block.name) +
        countTextTokens(JSON.stringify(block.input))
      );

    case "tool_result":
      // tool_result: content
      if (typeof block.content === "string") {
        return countTextTokens(block.content);
      }
      return block.content.reduce((sum, b) => sum + countBlockTokens(b), 0);

    case "thinking":
      return countTextTokens(block.thinking);

    default:
      return 0;
  }
}

/**
 * 计算消息的 token 数量
 */
function countMessageTokens(message: ClaudeMessage): number {
  // role token (约 2-3 tokens)
  let tokens = 3;

  if (typeof message.content === "string") {
    tokens += countTextTokens(message.content);
  } else {
    for (const block of message.content) {
      tokens += countBlockTokens(block);
    }
  }

  return tokens;
}

/**
 * 计算系统提示的 token 数量
 */
function countSystemTokens(
  system: string | { type: "text"; text: string }[] | undefined
): number {
  if (!system) return 0;

  if (typeof system === "string") {
    return countTextTokens(system);
  }

  return system.reduce((sum, block) => sum + countTextTokens(block.text), 0);
}

/**
 * 计算完整请求的 token 数量
 */
export function estimateTokenCount(body: {
  model?: string;
  system?: string | { type: "text"; text: string }[];
  messages?: ClaudeMessage[];
  tools?: unknown[];
}): number {
  let tokens = 0;

  // 系统提示
  tokens += countSystemTokens(body.system);

  // 消息
  if (body.messages) {
    for (const message of body.messages) {
      tokens += countMessageTokens(message);
    }
  }

  // 工具定义 - 序列化后计算实际 token
  if (body.tools && body.tools.length > 0) {
    tokens += countTextTokens(JSON.stringify(body.tools));
  }

  // 添加一些开销（格式化、特殊 tokens 等）
  tokens += 20;

  return tokens;
}

/**
 * 检测是否为 count_tokens 请求
 */
export function isCountTokensRequest(url: string | undefined): boolean {
  if (!url) return false;
  return url.includes("/count_tokens");
}

/**
 * 创建 count_tokens 响应
 */
export function createCountTokensResponse(inputTokens: number): string {
  return JSON.stringify({
    input_tokens: inputTokens,
  });
}
