import { generateId, safeJsonParse, toText } from "./utils";

type OpenAIChatChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
      function_call?: { name?: string; arguments?: string };
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; type?: string };
};

type ToolStreamState = {
  id: string;
  name: string;
  started: boolean;
  blockIndex: number;
};

function formatEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapFinishReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
    default:
      return "end_turn";
  }
}

export function convertChatCompletionSSEToAnthropicSSEStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";

      let messageStarted = false;
      let textBlockStarted = false;
      let textBlockStopped = false;
      let finishReason: string | null = null;
      let model = "";
      let openaiId = "";
      const messageId = generateId("msg_");
      let ended = false;

      const toolStates = new Map<number, ToolStreamState>();

      const emit = (text: string) => controller.enqueue(encoder.encode(text));

      const ensureMessageStart = () => {
        if (messageStarted) return;
        messageStarted = true;
        emit(
          formatEvent("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        );
      };

      const ensureTextBlockStart = () => {
        ensureMessageStart();
        if (textBlockStarted) return;
        textBlockStarted = true;
        emit(
          formatEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        );
      };

      const stopTextBlockIfNeeded = () => {
        if (!textBlockStarted || textBlockStopped) return;
        textBlockStopped = true;
        emit(formatEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
      };

      const ensureToolStart = (toolIndex: number, id: string, name: string) => {
        ensureMessageStart();
        const existing = toolStates.get(toolIndex);
        if (existing?.started) return;

        // If we ever start tools, stop text block first (Anthropic stream is sequential).
        stopTextBlockIfNeeded();

        const blockIndex = (textBlockStarted ? 1 : 0) + toolIndex;
        const st: ToolStreamState = {
          id: id || generateId("call_"),
          name: name || "tool",
          started: true,
          blockIndex,
        };
        toolStates.set(toolIndex, st);

        emit(
          formatEvent("content_block_start", {
            type: "content_block_start",
            index: st.blockIndex,
            content_block: { type: "tool_use", id: st.id, name: st.name, input: {} },
          }),
        );
      };

      const emitToolDelta = (toolIndex: number, partialJson: string) => {
        const st = toolStates.get(toolIndex);
        if (!st?.started) return;
        emit(
          formatEvent("content_block_delta", {
            type: "content_block_delta",
            index: st.blockIndex,
            delta: { type: "input_json_delta", partial_json: partialJson },
          }),
        );
      };

      const stopAllToolBlocks = () => {
        for (const st of toolStates.values()) {
          emit(formatEvent("content_block_stop", { type: "content_block_stop", index: st.blockIndex }));
        }
      };

      const finalize = () => {
        // Close remaining blocks
        stopTextBlockIfNeeded();
        stopAllToolBlocks();

        const stopReason = mapFinishReason(finishReason);
        ensureMessageStart();
        emit(
          formatEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
        );
        emit(formatEvent("message_stop", { type: "message_stop" }));
      };

      const emitError = (type: string, message: string) => {
        ensureMessageStart();
        emit(
          formatEvent("error", {
            type: "error",
            error: { type, message },
          }),
        );
      };

      const processEventBlock = (block: string) => {
        // OpenAI streams usually only contain `data:` lines.
        const lines = block.split("\n").filter((l) => l.length > 0);
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) return;
        const data = dataLines.join("\n");

        if (data === "[DONE]") {
          finalize();
          ended = true;
          return;
        }

        const json = safeJsonParse<OpenAIChatChunk>(data);
        if (!json) return;

        if (json.model) model = json.model;
        if (json.id && !openaiId) openaiId = json.id;

        if (json.error) {
          emitError(json.error.type || "api_error", json.error.message || "Upstream error");
          ended = true;
          return;
        }

        const choices = json.choices ?? [];
        for (const choice of choices) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;

          // Text deltas
          if (typeof delta.content === "string" && delta.content.length > 0) {
            ensureTextBlockStart();
            emit(
              formatEvent("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: delta.content },
              }),
            );
          }

          // tool_calls deltas
          const toolCalls = delta.tool_calls ?? [];
          for (const tc of toolCalls) {
            const idx = tc.index ?? 0;
            const id = toText(tc.id) || generateId("call_");
            const name = toText(tc.function?.name) || "tool";
            ensureToolStart(idx, id, name);
            const argsDelta = tc.function?.arguments;
            if (typeof argsDelta === "string" && argsDelta.length > 0) {
              emitToolDelta(idx, argsDelta);
            }
          }

          // Back-compat: function_call delta
          if (delta.function_call) {
            const idx = 0;
            const id = generateId("call_");
            const name = toText(delta.function_call.name) || "tool";
            ensureToolStart(idx, id, name);
            const argsDelta = delta.function_call.arguments;
            if (typeof argsDelta === "string" && argsDelta.length > 0) emitToolDelta(idx, argsDelta);
          }
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");

          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (block.trim().length === 0) continue;
            processEventBlock(block);
            if (ended) break;
          }

          if (ended) break;
        }
      } catch (err) {
        if (!ended) {
          emitError("stream_error", err instanceof Error ? err.message : String(err));
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        if (!ended) {
          // If upstream ends without [DONE], best-effort finalize.
          if (messageStarted || textBlockStarted || toolStates.size > 0) {
            finalize();
          }
        }
        controller.close();
      }
    },
  });
}
