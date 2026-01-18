import type {
  AnthropicContentBlock,
  OpenAIChatMessage,
} from "./types";
import { generateId, safeJsonParse } from "./utils";

type UrlCitation = { url: string; title?: string };

type OpenAIChatCompletionResponse = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: OpenAIChatMessage & {
      function_call?: { name: string; arguments: string };
      annotations?: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
};

function extractUrlCitations(annotations: unknown): UrlCitation[] {
  if (!Array.isArray(annotations)) return [];
  const out: UrlCitation[] = [];
  for (const ann of annotations) {
    if (!ann || typeof ann !== "object") continue;
    const a = ann as any;
    if (a.type !== "url_citation") continue;
    if (!a.url_citation || typeof a.url_citation !== "object") continue;
    const c = a.url_citation as any;
    const url = typeof c.url === "string" ? c.url : "";
    const title = typeof c.title === "string" ? c.title : undefined;
    if (url) out.push({ url, title });
  }
  return out;
}

function citationsToText(citations: UrlCitation[]): string {
  const lines: string[] = ["Sources:"];
  for (const c of citations) {
    const label = c.title ? `${c.title} — ` : "";
    lines.push(`- ${label}${c.url}`);
  }
  return lines.join("\n");
}

function mapFinishReasonToStopReason(finishReason: string | null | undefined): string {
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

function messageToContentBlocks(message: OpenAIChatMessage & { function_call?: { name: string; arguments: string } }): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  const content = message.content;
  if (typeof content === "string" && content) {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    const text = content
      .map((p) => (p && p.type === "text" ? p.text : ""))
      .filter(Boolean)
      .join("");
    if (text) blocks.push({ type: "text", text });
  }

  // Preserve web_search citations from providers that return OpenAI-style annotations.
  const citations = extractUrlCitations((message as any).annotations);
  if (citations.length > 0) {
    blocks.push({ type: "text", text: citationsToText(citations) });
  }

  const toolCalls = message.tool_calls ?? [];
  for (const tc of toolCalls) {
    if (!tc || tc.type !== "function") continue;
    const name = tc.function?.name || "";
    const args = tc.function?.arguments || "{}";
    const parsed = safeJsonParse<Record<string, unknown>>(args) ?? {};
    blocks.push({
      type: "tool_use",
      id: tc.id || generateId("call_"),
      name,
      input: parsed as any,
    });
  }

  // Back-compat: function_call (older)
  if (message.function_call && message.function_call.name) {
    const parsed = safeJsonParse<Record<string, unknown>>(message.function_call.arguments) ?? {};
    blocks.push({
      type: "tool_use",
      id: generateId("call_"),
      name: message.function_call.name,
      input: parsed as any,
    });
  }

  return blocks;
}

export function convertChatCompletionResponseToAnthropicMessage(
  bodyText: string,
): { statusCode?: number; headers?: Record<string, string>; body: string } {
  const parsed = safeJsonParse<OpenAIChatCompletionResponse>(bodyText);
  if (!parsed) {
    const err = {
      type: "error",
      error: { type: "invalid_json", message: "Upstream returned non-JSON body" },
    };
    return {
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(err),
    };
  }

  if (parsed.error) {
    const err = {
      type: "error",
      error: {
        type: parsed.error.type || "api_error",
        message: parsed.error.message || "Upstream error",
      },
    };
    return {
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(err),
    };
  }

  const choice = parsed.choices?.[0];
  const message = choice?.message;
  const finishReason = choice?.finish_reason ?? null;

  const stopReason = mapFinishReasonToStopReason(finishReason);
  const id = parsed.id ? (parsed.id.startsWith("msg_") ? parsed.id : `msg_${parsed.id}`) : generateId("msg_");

  const out = {
    id,
    type: "message",
    role: "assistant",
    model: parsed.model || "",
    content: message ? messageToContentBlocks(message) : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: parsed.usage?.prompt_tokens ?? 0,
      output_tokens: parsed.usage?.completion_tokens ?? 0,
    },
  };

  return {
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(out),
  };
}
