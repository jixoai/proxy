import { describe, expect, test } from "bun:test";

import {
  buildGeminiUrl,
  convertHeaders,
  convertRequest,
  convertRequestBody,
  extractCwd,
  isDroidRequest,
} from "../request-converter";

describe("request-converter", () => {
  test("extractCwd finds % pwd output in system", () => {
    const cwd = extractCwd({
      system: "Some header\n% pwd\n/Users/test/project\nmore",
      messages: [],
    });
    expect(cwd).toBe("/Users/test/project");
  });

  test("extractCwd finds % pwd output in messages", () => {
    const cwd = extractCwd({
      system: "no pwd here",
      messages: [{ role: "user", content: "% pwd\n/Users/test/from-message" }],
    });
    expect(cwd).toBe("/Users/test/from-message");
  });

  test("isDroidRequest detects Droid marker in system", () => {
    const ok = isDroidRequest({
      system: "You are Droid Factory",
      messages: [],
    });
    expect(ok).toBe(true);
  });

  test("convertRequest returns empty result for non-droid requests", () => {
    const res = convertRequest({
      headers: {},
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        system: "plain system",
        messages: [{ role: "user", content: "hi" }],
      }),
      upstreamBaseUrl: "https://example.com/v1beta",
    });
    expect(res.url).toBeUndefined();
    expect(res.headers).toBeUndefined();
    expect(res.body).toBeUndefined();
  });

  test("convertRequestBody maps WebSearch tool_use/tool_result to google_web_search functionCall/functionResponse", () => {
    const out = convertRequestBody({
      model: "gemini-2.5-pro",
      system: "Droid",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "WebSearch",
              input: { query: "bun test", extra: "ignored" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "result text",
            },
          ],
        },
      ],
      tools: [
        {
          name: "WebSearch",
          description: "web search",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    } as any);

    expect((out.tools?.[0] as { functionDeclarations?: { name: string }[] })?.functionDeclarations?.[0]?.name).toBe("google_web_search");

    const functionCallPart = out.contents
      .flatMap((c: any) => c.parts)
      .find((p: any) => "functionCall" in p);
    expect(functionCallPart?.functionCall?.name).toBe("google_web_search");
    expect(functionCallPart?.functionCall?.args).toEqual({ query: "bun test" });

    const functionResponsePart = out.contents
      .flatMap((c: any) => c.parts)
      .find((p: any) => "functionResponse" in p);
    expect(functionResponsePart?.functionResponse?.id).toBe("toolu_1");
    expect(functionResponsePart?.functionResponse?.name).toBe("google_web_search");
    expect(functionResponsePart?.functionResponse?.response?.output).toBe("result text");

    expect(out.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
    expect(out.generationConfig?.thinkingConfig?.thinkingBudget).toBe(8192);
  });

  test("convertHeaders derives x-goog-api-key from Bearer token", () => {
    const headers = convertHeaders({ authorization: "Bearer test_token" });
    expect(headers["x-goog-api-key"]).toBe("test_token");
    expect(headers["authorization"]).toBeUndefined();
  });

  test("buildGeminiUrl normalizes baseUrl/model and stream flag", () => {
    const url = buildGeminiUrl("https://example.com/v1beta/", "gemini-2.5-pro", true);
    expect(url).toBe("https://example.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
  });
});
