import { describe, expect, test } from "bun:test";
import { convertAnthropicToOpenAIChatCompletionRequest, isAnthropicMessagesRequest, rewriteRequest } from "../request-converter";

describe("chat4droid request-converter", () => {
  test("detects Anthropic Messages request", () => {
    const body = {
      model: "claude-opus-4.5",
      max_tokens: 100,
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    expect(isAnthropicMessagesRequest(body)).toBe(true);
  });

  test("converts system/messages/tools to OpenAI chat.completions shape", () => {
    const req = {
      model: "claude-opus-4.5",
      max_tokens: 123,
      system: [{ type: "text", text: "You are Droid." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/a" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file content" }] },
      ],
      tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "Read" },
      stream: true,
      thinking: { type: "enabled", budget_tokens: 1000 },
    } as any;

    const out = convertAnthropicToOpenAIChatCompletionRequest(req);
    expect(out.model).toBe("claude-opus-4.5");
    expect(out.stream).toBe(true);
    expect(out.max_tokens).toBe(123);
    // Best-effort: map Anthropic thinking.enabled to OpenAI reasoning_effort.
    expect((out as any).reasoning_effort).toBe("high");
    expect(out.messages[0]?.role).toBe("system");
    expect(typeof out.messages[0]?.content).toBe("string");
    expect(out.tools?.[0]?.type).toBe("function");
    expect(out.tool_choice && typeof out.tool_choice === "object").toBe(true);

    // tool_result becomes role=tool message
    expect(out.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
  });

  test("maps Claude web_search server tool to Hicap web_search_options", () => {
    const req = {
      model: "claude-opus-4.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    } as any;

    const out = convertAnthropicToOpenAIChatCompletionRequest(req);
    expect((out as any).web_search_options).toBeTruthy();
    expect((out as any).web_search_options.user_location.type).toBe("approximate");
    expect(out.tools).toBeUndefined();
  });

  test("maps Anthropic thinking.enabled to reasoning_effort=high (best-effort)", () => {
    const req = {
      model: "claude-opus-4.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "enabled", budget_tokens: 1000 },
    } as any;

    const out = convertAnthropicToOpenAIChatCompletionRequest(req);
    expect((out as any).reasoning_effort).toBe("high");
  });

  test("rewriteRequest strips anthropic headers and authorization ambiguity", () => {
    const result = rewriteRequest({
      url: "https://api.hicap.ai/v1/messages",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer xx",
        "api-key": "real_key",
      },
      body: {
        model: "claude-opus-4.5",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(result.url).toBe("https://api.hicap.ai/v1/chat/completions");
    expect(result.headers["anthropic-version"]).toBeUndefined();
    expect(result.headers.authorization).toBeUndefined();
    expect(result.headers["api-key"]).toBe("real_key");
  });
});
