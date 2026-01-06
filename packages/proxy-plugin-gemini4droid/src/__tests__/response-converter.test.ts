import { describe, expect, test } from "bun:test";

import { convertErrorResponse, convertStreamChunk, createStreamState } from "../response-converter";

describe("response-converter", () => {
  test("converts plain text stream chunk into text_delta and end_turn", () => {
    const state = createStreamState("gemini-2.5-pro");
    const chunk = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Hello" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    } as any;

    const out = convertStreamChunk(chunk, state);

    expect(out).toContain("event:message_start");
    expect(out).toContain("event:content_block_start");
    expect(out).toContain("\"type\":\"text_delta\"");
    expect(out).toContain("\"text\":\"Hello\"");
    expect(out).toContain("\"stop_reason\":\"end_turn\"");
    expect(out).toContain("event:message_stop");
  });

  test("converts functionCall into tool_use block and stop_reason tool_use", () => {
    const state = createStreamState("gemini-2.5-pro");
    const chunk = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "do_something",
                  args: { a: 1 },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    } as any;

    const out = convertStreamChunk(chunk, state);

    expect(out).toContain("\"type\":\"tool_use\"");
    expect(out).toContain("\"name\":\"do_something\"");
    expect(out).toContain("\"type\":\"input_json_delta\"");
    expect(out).toContain("\"stop_reason\":\"tool_use\"");
  });

  test("converts thought text into thinking_delta", () => {
    const state = createStreamState("gemini-2.5-pro");
    const chunk = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "thinking...", thought: true }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    } as any;

    const out = convertStreamChunk(chunk, state);

    expect(out).toContain("\"type\":\"thinking_delta\"");
    expect(out).toContain("thinking...");
    expect(out).toContain("\"stop_reason\":\"end_turn\"");
  });

  test("maps Gemini rate limit error to Anthropic rate_limit_error", () => {
    const out = convertErrorResponse({
      error: {
        code: 429,
        message: "Rate limit exceeded",
        status: "RESOURCE_EXHAUSTED",
      },
    } as any);

    expect(out.type).toBe("error");
    expect(out.error.type).toBe("rate_limit_error");
    expect(out.error.code).toBe("rate_limit_exceeded");
  });
});

