/**
 * 测试数据：基于真实 Anthropic API 请求结构
 */

import type { AnthropicRequestBody, TextBlock, Message } from "../types";

export const sampleHeaders: Record<string, string> = {
  host: "localhost:20003",
  "user-agent": "factory-cli/0.36.5",
  accept: "application/json",
  "anthropic-beta": "interleaved-thinking-2025-05-14",
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
  "x-api-key": "sk-ant-test-key-12345",
  authorization: "Bearer sk-ant-test-key-12345",
};

export const sampleHeadersWithSessionId: Record<string, string> = {
  ...sampleHeaders,
  "x-session-id": "test-session-abc123",
};

export const sampleSystem: TextBlock[] = [
  {
    type: "text",
    text: "You are Droid, an AI software engineering agent built by Factory.",
  },
  {
    type: "text",
    text: `You work within an interactive cli tool and you are focused on helping users with any software engineering tasks.
Guidelines:
- Use tools when necessary.
- Don't stop until all user tasks are completed.`,
    cache_control: { type: "ephemeral" },
  },
];

export const sampleMessages: Message[] = [
  {
    role: "user",
    content: [
      {
        type: "text" as const,
        text: "<system-reminder>\nUser system info (darwin 25.1.0)\nModel: Opus 4.5\n</system-reminder>",
      },
      {
        type: "text" as const,
        text: "Hello",
        cache_control: { type: "ephemeral" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text" as const,
        text: "I'll help you with that task.",
      },
    ],
  },
  {
    role: "user",
    content: "Please analyze the code.",
  },
];

export const sampleRequestBody: AnthropicRequestBody = {
  model: "claude-opus-4-5-20251101",
  max_tokens: 32000,
  stream: true,
  system: sampleSystem,
  messages: sampleMessages,
};

export const sampleRequestBodyMinimal: AnthropicRequestBody = {
  model: "claude-3-sonnet-20240229",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: "Hello",
    },
  ],
};

export const sampleRequestBodyWithStringSystem: AnthropicRequestBody = {
  model: "claude-3-haiku-20240307",
  max_tokens: 1024,
  system: "You are a helpful assistant.",
  messages: [
    {
      role: "user",
      content: "Hi",
    },
  ],
};

export function createLargeRequestBody(messageCount: number): AnthropicRequestBody {
  const messages = [];
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message ${i}: ${"x".repeat(100)}`,
    });
  }
  return {
    model: "claude-opus-4-5-20251101",
    max_tokens: 32000,
    stream: true,
    system: sampleSystem,
    messages,
  };
}
