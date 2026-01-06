import { describe, expect, test } from "bun:test";

import { convertStreamChunk, convertStreamResponse, createStreamState } from "../response-converter";

describe("websearch", () => {
  test("emits tool_use(WebSearch) for google_web_search functionCall", () => {
    const state = createStreamState("gemini-2.5-pro");

    const chunk = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "google_web_search",
                  args: { query: "react-activity library usage" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        cachedContentTokenCount: 0,
      },
    } as any;

    const out = convertStreamChunk(chunk, state);

    expect(out).toContain("\"type\":\"tool_use\"");
    expect(out).toContain("\"name\":\"WebSearch\"");
    expect(out).toContain("\"stop_reason\":\"tool_use\"");
    expect(out).not.toContain("\"type\":\"server_tool_use\"");
    expect(out).not.toContain("\"type\":\"web_search_tool_result\"");
  });

  test("does not emit content_block_stop when no block started", () => {
    const geminiSse = `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [] } }],
    })}\n\n`;

    const out = convertStreamResponse(geminiSse, "gemini-2.5-pro");

    expect(out).toContain("event:message_start");
    expect(out).toContain("event:message_delta");
    expect(out).toContain("event:message_stop");
    expect(out).not.toContain("event:content_block_stop");
  });
});
