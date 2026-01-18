import { describe, expect, test } from "bun:test";
import { convertChatCompletionResponseToAnthropicMessage } from "../response-converter";

describe("chat4droid response-converter", () => {
  test("converts OpenAI chat completion JSON to Anthropic message JSON", () => {
    const openai = {
      id: "chatcmpl_123",
      object: "chat.completion",
      created: 0,
      model: "claude-opus-4.5",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "hello",
            annotations: [
              {
                type: "url_citation",
                url_citation: { url: "https://example.com", title: "Example" },
              },
            ],
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/tmp/a\"}" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    };

    const out = convertChatCompletionResponseToAnthropicMessage(JSON.stringify(openai));
    const parsed = JSON.parse(out.body);
    expect(parsed.type).toBe("message");
    expect(parsed.role).toBe("assistant");
    expect(parsed.model).toBe("claude-opus-4.5");
    expect(parsed.content.some((b: any) => b.type === "text" && b.text === "hello")).toBe(true);
    expect(parsed.content.some((b: any) => b.type === "text" && String(b.text).includes("https://example.com"))).toBe(
      true,
    );
    expect(parsed.content.some((b: any) => b.type === "tool_use" && b.name === "Read")).toBe(true);
  });
});
