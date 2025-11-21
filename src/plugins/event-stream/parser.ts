import type { EventStreamMessage } from "./types";

const utf8Decoder = new TextDecoder("utf-8");

function normalizeLineBreaks(input: string) {
  return input.replace(/\r\n?/g, "\n");
}

export function parseEventStreamPayload(value: Uint8Array): EventStreamMessage[] {
  let text: string;
  try {
    text = utf8Decoder.decode(value);
  } catch (error) {
    console.error("[eventStream] Failed to decode payload", error);
    return [];
  }

  const lines = normalizeLineBreaks(text).split("\n");
  const messages: EventStreamMessage[] = [];
  const chunkLines: string[] = [];
  let dataLines: string[] = [];
  let current: Partial<EventStreamMessage & { retry?: number }> = {};

  const flush = () => {
    if (!chunkLines.length && dataLines.length === 0) {
      current = {};
      return;
    }
    const data = dataLines.join("\n");
    if (!data && !current.event && !current.id) {
      chunkLines.length = 0;
      dataLines = [];
      current = {};
      return;
    }
    messages.push({
      index: messages.length,
      id: current.id,
      event: current.event,
      retry: current.retry,
      data,
      raw: chunkLines.join("\n"),
    });
    chunkLines.length = 0;
    dataLines = [];
    current = {};
  };

  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }
    chunkLines.push(line);
    if (line.startsWith(":")) {
      continue;
    }
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let valuePart = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (valuePart.startsWith(" ")) {
      valuePart = valuePart.slice(1);
    }
    switch (field) {
      case "event":
        current.event = valuePart;
        break;
      case "data":
        dataLines.push(valuePart);
        break;
      case "id":
        current.id = valuePart;
        break;
      case "retry":
        current.retry = Number(valuePart);
        break;
      default:
        break;
    }
  }
  flush();
  return messages;
}
