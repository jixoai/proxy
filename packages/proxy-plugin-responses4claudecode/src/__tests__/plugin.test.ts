/**
 * Plugin onRequest 集成测试
 */

import { describe, it, expect } from "bun:test";
import { createResponses4ClaudeCodePlugin } from "../plugin";

describe("Responses4ClaudeCode Plugin", () => {
  it("forwards injected TaskOutput tool_result into rewriteRequest", async () => {
    const plugin = createResponses4ClaudeCodePlugin({ debug: false });

    const claudeRequest = {
      model: "gpt-5.2",
      max_tokens: 128,
      stream: true,
      metadata: { user_id: "user_test_session_deadbeef" },
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "TaskOutput",
              input: { task_id: "task_missing", block: false },
            },
          ],
        },
      ],
    };

    const result = await plugin.onRequest?.({
      meta: {
        method: "POST",
        url: "http://example.com/messages",
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(JSON.stringify(claudeRequest), "utf-8"),
    });

    expect(result).not.toBeNull();
    expect(result && "body" in result).toBe(true);
    expect(result && "respondWith" in result).toBe(false);

    const rewritten = JSON.parse((result as { body: Buffer }).body.toString("utf-8"));
    expect(Array.isArray(rewritten.input)).toBe(true);

    const hasInjectedToolResult = rewritten.input.some(
      (item: { type?: string; call_id?: string }) =>
        item.type === "function_call_output" && item.call_id === "call_123"
    );
    expect(hasInjectedToolResult).toBe(true);
  });
});

