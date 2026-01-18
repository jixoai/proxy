import type {
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicToolChoice,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIChatTool,
  OpenAIToolChoice,
  JsonValue,
} from "./types";

import { joinNonEmpty, safeJsonStringify } from "./utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isAnthropicMessagesRequest(body: unknown): body is AnthropicMessagesRequest {
  if (!isRecord(body)) return false;
  if (typeof body.model !== "string") return false;
  if (typeof body.max_tokens !== "number") return false;
  if (!Array.isArray(body.messages)) return false;
  // Anthropic Messages requests typically have top-level `system` and/or `thinking`.
  // We avoid overfitting: accept if messages look like Anthropic roles.
  for (const msg of body.messages) {
    if (!isRecord(msg)) return false;
    if (msg.role !== "user" && msg.role !== "assistant") return false;
    // content can be string or array
    if (
      !(
        typeof msg.content === "string" ||
        (Array.isArray(msg.content) && msg.content.every((b) => isRecord(b) && typeof b.type === "string"))
      )
    ) {
      return false;
    }
  }
  return true;
}

function systemToText(system: AnthropicMessagesRequest["system"]): string | null {
  if (!system) return null;
  if (typeof system === "string") return system.trim() || null;
  const parts = system
    .map((b) => (b && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean);
  const text = joinNonEmpty(parts, "\n\n");
  return text || null;
}

function anthropicBlocksToText(blocks: AnthropicContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof (block as any).text === "string") {
      parts.push((block as any).text);
      continue;
    }
    if (block.type === "thinking" && typeof (block as any).thinking === "string") {
      // Best-effort: preserve thinking as plain text tag in history.
      parts.push(`<thinking>${(block as any).thinking}</thinking>`);
      continue;
    }
  }
  return joinNonEmpty(parts, "\n");
}

function toolResultContentToText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return anthropicBlocksToText(content);
}

function isWebSearchServerTool(tool: AnthropicTool): boolean {
  if (!tool || typeof tool !== "object") return false;
  // Claude web search tool (server tool) typically looks like:
  // { type: "web_search_20250305", name: "web_search", ... }
  const t = tool as Record<string, unknown>;
  const type = typeof t.type === "string" ? t.type : "";
  const name = typeof t.name === "string" ? t.name : "";
  return type.startsWith("web_search") && name === "web_search";
}

function buildWebSearchOptionsFromAnthropicTool(tool: AnthropicTool): Record<string, unknown> {
  const t = tool as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Best-effort mapping; Hicap docs accept `user_location: { type: "approximate" }` at minimum.
  if (isRecord(t.user_location)) {
    out.user_location = t.user_location;
  } else {
    out.user_location = { type: "approximate" };
  }

  // Pass-through if present on tool config
  if (typeof t.search_context_size === "string") {
    out.search_context_size = t.search_context_size;
  }

  return out;
}

function convertToolsAndWebSearchOptions(tools: AnthropicTool[] | undefined): {
  tools?: OpenAIChatTool[];
  web_search_options?: Record<string, unknown>;
} {
  if (!Array.isArray(tools) || tools.length === 0) return {};

  const outTools: OpenAIChatTool[] = [];
  let webSearchOptions: Record<string, unknown> | undefined;

  for (const t of tools) {
    if (!t || typeof t !== "object") continue;

    if (isWebSearchServerTool(t)) {
      // Prefer first occurrence
      if (!webSearchOptions) webSearchOptions = buildWebSearchOptionsFromAnthropicTool(t);
      continue;
    }

    if (typeof (t as any).name !== "string" || !(t as any).name) continue;
    outTools.push({
      type: "function",
      function: {
        name: (t as any).name,
        description: typeof (t as any).description === "string" ? (t as any).description : undefined,
        parameters: ((t as any).input_schema as Record<string, JsonValue> | undefined) ?? undefined,
      },
    });
  }

  return {
    tools: outTools.length > 0 ? outTools : undefined,
    web_search_options: webSearchOptions,
  };
}

function convertToolChoice(choice: AnthropicToolChoice | undefined): OpenAIToolChoice | undefined {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && "name" in choice && typeof choice.name === "string" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function convertAnthropicMessage(msg: AnthropicMessage): OpenAIChatMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const out: OpenAIChatMessage[] = [];

  const textParts: string[] = [];
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

  const flushUserText = () => {
    const text = joinNonEmpty(textParts, "\n");
    if (!text) return;
    out.push({ role: "user", content: text });
    textParts.length = 0;
  };

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text": {
        const t = (block as any).text;
        if (typeof t === "string" && t) textParts.push(t);
        break;
      }
      case "thinking": {
        const t = (block as any).thinking;
        if (typeof t === "string" && t) textParts.push(`<thinking>${t}</thinking>`);
        break;
      }
      case "tool_use": {
        if (msg.role !== "assistant") {
          // Invalid but keep as text fallback.
          textParts.push(`[tool_use] ${(block as any).name ?? ""}`.trim());
          break;
        }
        const id = typeof (block as any).id === "string" && (block as any).id ? (block as any).id : "";
        const name = typeof (block as any).name === "string" ? (block as any).name : "";
        const input = (block as any).input && typeof (block as any).input === "object" ? (block as any).input : {};
        toolCalls.push({ id: id || `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name, arguments: safeJsonStringify(input, "{}") } });
        break;
      }
      case "tool_result": {
        if (msg.role !== "user") {
          textParts.push(`[tool_result] ${(block as any).tool_use_id ?? ""}`.trim());
          break;
        }
        // Anthropic requires tool_result blocks to be first; we still handle mixed content safely.
        flushUserText();
        const toolCallId = typeof (block as any).tool_use_id === "string" ? (block as any).tool_use_id : "";
        const content = toolResultContentToText((block as any).content);
        out.push({ role: "tool", tool_call_id: toolCallId, content });
        break;
      }
      default: {
        // Unknown block: serialize for visibility (best-effort).
        textParts.push(`[${String((block as any).type || "unknown")}] ${safeJsonStringify(block, "")}`.trim());
        break;
      }
    }
  }

  const remainingText = joinNonEmpty(textParts, "\n");
  if (msg.role === "assistant") {
    const assistant: OpenAIChatMessage = { role: "assistant" };
    if (remainingText) assistant.content = remainingText;
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
    if (assistant.content || assistant.tool_calls) out.push(assistant);
  } else {
    if (remainingText) out.push({ role: "user", content: remainingText });
  }

  return out;
}

function hasToolUseHistoryInOpenAIMessages(messages: OpenAIChatMessage[]): boolean {
  for (const m of messages) {
    if (!m) continue;
    if (m.role === "tool") return true;
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
  }
  return false;
}

export function convertAnthropicToOpenAIChatCompletionRequest(
  request: AnthropicMessagesRequest,
): OpenAIChatCompletionRequest {
  const openaiMessages: OpenAIChatMessage[] = [];

  const systemText = systemToText(request.system);
  if (systemText) {
    openaiMessages.push({ role: "system", content: systemText });
  }

  for (const msg of request.messages ?? []) {
    openaiMessages.push(...convertAnthropicMessage(msg));
  }

  const { tools: openaiTools, web_search_options: webSearchOptionsFromTools } =
    convertToolsAndWebSearchOptions(request.tools);

  const out: OpenAIChatCompletionRequest = {
    model: request.model,
    messages: openaiMessages,
    stream: request.stream ?? undefined,
    max_tokens: request.max_tokens,
    temperature: typeof request.temperature === "number" ? request.temperature : undefined,
    top_p: typeof request.top_p === "number" ? request.top_p : undefined,
    stop: Array.isArray(request.stop_sequences)
      ? request.stop_sequences.length === 1
        ? request.stop_sequences[0]
        : request.stop_sequences
      : undefined,
    tools: openaiTools,
    tool_choice: convertToolChoice(request.tool_choice),
  };

  // Hicap OpenAI endpoint supports web_search_options / reasoning_effort / verbosity.
  // If caller explicitly provides these (non-standard on Anthropic), pass through.
  if (isRecord((request as any).web_search_options)) {
    out.web_search_options = (request as any).web_search_options;
  } else if (webSearchOptionsFromTools) {
    out.web_search_options = webSearchOptionsFromTools;
  }

  if (typeof (request as any).reasoning_effort === "string") {
    out.reasoning_effort = (request as any).reasoning_effort;
  }

  if (typeof (request as any).verbosity === "string") {
    out.verbosity = (request as any).verbosity;
  }

  // NOTE: Tool-use history + thinking can trigger strict validation on some upstreams.
  // We don't try to "disable thinking" here (provider-specific). The plugin request hook
  // may further sanitize the final OpenAI request before forwarding.

  // Best-effort: if caller enables Anthropic "thinking", default to higher reasoning effort upstream.
  // (Does not override an explicit reasoning_effort.)
  if (out.reasoning_effort === undefined) {
    const thinking = (request as any).thinking;
    if (isRecord(thinking) && thinking.type === "enabled") {
      out.reasoning_effort = "high";
    }
  }

  return out;
}

function rewriteUrlToChatCompletions(targetUrl: string): string | null {
  if (!targetUrl) return null;
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }

  const path = url.pathname || "/";

  // Prefer preserving provider base path (e.g. /v2/openai or /v1)
  if (path.includes("/v2/openai")) {
    url.pathname = "/v2/openai/chat/completions";
    return url.href;
  }
  if (path.includes("/v1/")) {
    const prefix = path.split("/v1/")[0] + "/v1";
    url.pathname = `${prefix}/chat/completions`;
    return url.href;
  }

  if (path.endsWith("/messages")) {
    url.pathname = path.replace(/\/messages$/, "/chat/completions");
    return url.href;
  }

  return null;
}

export function rewriteRequest(params: {
  headers: Record<string, string>;
  url: string;
  body: AnthropicMessagesRequest;
}): { headers: Record<string, string>; url: string; body: string } {
  const { headers, url, body } = params;

  const newUrl = rewriteUrlToChatCompletions(url) ?? url;

  // Hicap OpenAI endpoint expects `api-key`.
  // Best-effort: map common auth headers without overwriting explicit api-key.
  const nextHeaders: Record<string, string> = { ...headers };
  if (!nextHeaders["api-key"]) {
    if (nextHeaders["x-api-key"]) {
      nextHeaders["api-key"] = nextHeaders["x-api-key"];
    } else if (nextHeaders["authorization"]) {
      const token = nextHeaders["authorization"].match(/^bearer\s+(.+)$/i)?.[1]?.trim();
      if (token) nextHeaders["api-key"] = token;
    }
  }

  // Strip Anthropic-only headers when talking to an OpenAI-style upstream.
  for (const key of Object.keys(nextHeaders)) {
    if (key.startsWith("anthropic-")) delete nextHeaders[key];
  }

  // Avoid auth ambiguity: prefer `api-key` and drop common alternates.
  if (nextHeaders["api-key"]) {
    delete nextHeaders["x-api-key"];
    if (/^bearer\s+/i.test(nextHeaders["authorization"] ?? "")) {
      delete nextHeaders["authorization"];
    }
  }

  const openaiBody = convertAnthropicToOpenAIChatCompletionRequest(body);

  // Provider constraint: thinking + tools may error on some backends.
  // We intentionally drop all Anthropic-only fields (thinking/output_config/etc) here.
  // If the caller wants reasoning, they should use the provider's OpenAI-side knobs explicitly.

  return {
    headers: nextHeaders,
    url: newUrl,
    body: JSON.stringify(openaiBody),
  };
}
