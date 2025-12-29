import { describe, it, expect } from "bun:test";
import { convertSSEResponse } from "../response-converter";

type SseEvent = { event: string; data: unknown };

function encodeClaudeSse(events: SseEvent[]): string {
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

function decodeCodexSse(text: string): Array<{ event: string; data: any }> {
  const result: Array<{ event: string; data: any }> = [];
  let currentEvent: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:") && currentEvent) {
      const raw = line.slice(5).trim();
      result.push({ event: currentEvent, data: JSON.parse(raw) });
      currentEvent = null;
    }
  }
  return result;
}

describe("response-converter", () => {
  it("converts apply_patch tool_use → custom_tool_call SSE events", () => {
    const patch = "*** Begin Patch\n*** End Patch";

    const claudeSse = encodeClaudeSse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_abc", name: "apply_patch", input: {} },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ patch }) },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);

    const converted = convertSSEResponse(claudeSse);
    const events = decodeCodexSse(converted);

    const added = events.find((e) => e.event === "response.output_item.added" && e.data?.item?.type === "custom_tool_call");
    expect(added?.data?.item?.name).toBe("apply_patch");

    const inputDone = events.find((e) => e.event === "response.custom_tool_call_input.done");
    expect(inputDone?.data?.input).toBe(patch);

    const done = events.find((e) => e.event === "response.output_item.done" && e.data?.item?.type === "custom_tool_call");
    expect(done?.data?.item?.input).toBe(patch);
  });

  it("converts TodoWrite tool_use → update_plan function_call with converted arguments", () => {
    const todos = ["1. [in_progress] Step A", "2. [pending] Step B"].join("\n");

    const claudeSse = encodeClaudeSse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_2",
            type: "message",
            role: "assistant",
            model: "claude-opus",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_todo", name: "TodoWrite", input: {} },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ todos }) },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);

    const converted = convertSSEResponse(claudeSse);
    const events = decodeCodexSse(converted);

    const added = events.find((e) => e.event === "response.output_item.added" && e.data?.item?.type === "function_call");
    expect(added?.data?.item?.name).toBe("update_plan");

    const argsDone = events.find((e) => e.event === "response.function_call_arguments.done");
    const args = JSON.parse(argsDone?.data?.arguments ?? "{}");
    expect(args.plan).toEqual([
      { step: "Step A", status: "in_progress" },
      { step: "Step B", status: "pending" },
    ]);
  });
});

