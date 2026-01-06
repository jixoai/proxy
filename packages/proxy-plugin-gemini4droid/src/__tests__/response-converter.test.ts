import { describe, expect, test } from "bun:test";

import {
  convertErrorResponse,
  convertStreamChunk,
  convertStreamResponse,
  createStreamState,
} from "../response-converter";

function parseSseEvents(text: string): Array<{ event: string; data: any }> {
  const blocks = text.split("\n\n").filter((b) => b.trim().length > 0);
  const events: Array<{ event: string; data: any }> = [];

  for (const block of blocks) {
    let eventName = "";
    let dataJson = "";

    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
      if (line.startsWith("data:")) dataJson = line.slice("data:".length);
    }

    if (!eventName || !dataJson) continue;
    events.push({ event: eventName, data: JSON.parse(dataJson) });
  }

  return events;
}

describe("response-converter", () => {
  test("stream response: fills input/cache tokens even when usageMetadata only appears in last chunk", () => {
    const geminiSSE = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hello" }] },
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({
        candidates: [
          {
            content: { role: "model", parts: [] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 3,
        },
      })}`,
      "",
    ].join("\n");

    const out = convertStreamResponse(geminiSSE, "gemini-2.5-pro");
    const events = parseSseEvents(out);

    const msgStart = events.find((e) => e.event === "message_start");
    expect(msgStart?.data?.message?.usage?.input_tokens).toBe(10);
    expect(msgStart?.data?.message?.usage?.cache_read_input_tokens).toBe(3);
    expect(msgStart?.data?.message?.usage?.cache_creation_input_tokens).toBe(0);

    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta?.data?.usage?.input_tokens).toBe(10);
    expect(msgDelta?.data?.usage?.cache_read_input_tokens).toBe(3);
    expect(msgDelta?.data?.usage?.cache_creation_input_tokens).toBe(0);
    expect(msgDelta?.data?.usage?.output_tokens).toBe(5);
  });

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
