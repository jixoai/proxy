import { describe, expect, test } from "bun:test";
import { convertChatCompletionSSEToAnthropicSSEStream } from "../sse-converter";

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("chat4droid sse-converter", () => {
  test("converts OpenAI chat.completion.chunk SSE to Anthropic SSE", async () => {
    const openaiSse =
      [
        `data: ${JSON.stringify({ id: "chatcmpl_1", model: "claude-opus-4.5", choices: [{ delta: { content: "hi" } }] })}`,
        ``,
        `data: ${JSON.stringify({ id: "chatcmpl_1", model: "claude-opus-4.5", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/tmp/a\"}" } }] } }] })}`,
        ``,
        `data: ${JSON.stringify({ id: "chatcmpl_1", model: "claude-opus-4.5", choices: [{ finish_reason: "tool_calls", delta: {} }] })}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n");

    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(openaiSse));
        controller.close();
      },
    });

    const converted = await readStream(convertChatCompletionSSEToAnthropicSSEStream(upstream));
    expect(converted).toContain("event: message_start");
    expect(converted).toContain("event: content_block_start");
    expect(converted).toContain("tool_use");
    expect(converted).toContain("event: message_stop");
  });
});
