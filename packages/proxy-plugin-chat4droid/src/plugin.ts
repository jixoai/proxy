import { z } from "zod";
import type {
  ProxyPlugin,
  RequestHookParams,
  RequestHookResult,
  ResponseHookParams,
  ResponseHookResult,
  RequestMeta,
  ResponseMeta,
  PrecheckResult,
  PluginLogger,
} from "@jixo/proxy-plugin";
import {
  normalizeHeaders,
  createLogger,
  safeParseJson,
  isJsonContentType,
  isEventStreamContentType,
  readStreamToBuffer,
  streamFromBuffer,
} from "@jixo/proxy-plugin";

import { isAnthropicMessagesRequest, rewriteRequest } from "./request-converter";
import { convertChatCompletionResponseToAnthropicMessage } from "./response-converter";
import { convertChatCompletionSSEToAnthropicSSEStream } from "./sse-converter";

const StoreSchema = z.object({
  activated: z.literal(true),
});

type Store = z.infer<typeof StoreSchema>;

export interface DroidPluginOptions {
  debug?: boolean;
  logDir?: string;
  /**
   * Some upstreams (e.g. Bedrock ConverseStream) enforce that when "thinking" is enabled,
   * any assistant tool_use message must start with a thinking block. OpenAI chat.completions
   * tool_calls history can't represent that structure reliably.
   *
   * Workaround: drop structured tool history (tool_calls/tool messages) and keep only a
   * human-readable transcript so the upstream won't see tool_use blocks in history.
   */
  toolUseThinkingPolicy?: "disable" | "flatten" | "auto";
}

function urlEndsWithMessages(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/messages");
  } catch {
    return false;
  }
}

function urlEndsWithChatCompletions(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/chat/completions");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function looksLikeOpenAIChatCompletionsRequest(body: unknown): body is Record<string, unknown> {
  if (!isRecord(body)) return false;
  if (typeof body.model !== "string") return false;
  if (!Array.isArray(body.messages)) return false;
  return true;
}

function hasActivatedStoreHeader(headers: Record<string, string>): boolean {
  // PluginStore header key is derived from hook/pluginName, not plugin.name.
  // In normal configs this is `proxy-plugin-chat4droid`, but we keep this robust by:
  // - scanning store headers
  // - narrowing to keys containing "chat4droid"
  // - validating payload shape
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (!k.startsWith("-x-jixo-store-")) continue;
    if (!k.includes("chat4droid")) continue;
    if (!value) continue;
    const parsed = safeParseJson(value);
    if (!parsed) continue;
    if (StoreSchema.safeParse(parsed).success) return true;
  }
  return false;
}

function looksLikeClaudeModel(model: unknown): boolean {
  return typeof model === "string" && model.toLowerCase().includes("claude");
}

function getNumericTokenLimit(body: Record<string, unknown>): number | null {
  const maxCompletionTokens = (body as any).max_completion_tokens;
  if (typeof maxCompletionTokens === "number" && Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0) {
    return maxCompletionTokens;
  }
  const maxTokens = (body as any).max_tokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    return maxTokens;
  }
  return null;
}

function getMinClaudeMaxTokensForUpstreamThinkingBudget(reasoningEffort: unknown): number {
  // Empirically derived from Hicap -> Bedrock Converse mapping:
  // Bedrock requires `thinking.enabled.budget_tokens >= 1024`, and Hicap seems to derive budget_tokens
  // from max_tokens with a ratio influenced by reasoning_effort.
  //
  // - high:   budget ~= max_tokens - 1  -> min max_tokens = 1025
  // - medium: budget ~= floor(max_tokens * 0.6) -> min max_tokens = 1707
  // - low:    budget ~= floor(max_tokens * 0.3) -> min max_tokens = 3414
  //
  // When omitted, upstream behaves like "medium".
  const effort = typeof reasoningEffort === "string" ? reasoningEffort : "";
  if (effort === "high") return 1025;
  if (effort === "low") return 3414;
  // default / "medium"
  return 1707;
}

function ensureClaudeMinMaxTokens(
  body: Record<string, unknown>,
): { changed: boolean; next: Record<string, unknown> } {
  // Observed provider behavior (Hicap -> Bedrock Converse):
  // they may map `max_tokens` (or `max_completion_tokens`) to `thinking.enabled.budget_tokens`,
  // and Bedrock requires budget_tokens >= 1024.
  //
  // To keep small requests working, we bump the token limit to a minimum that satisfies the
  // upstream thinking budget constraint.
  if (!looksLikeClaudeModel(body.model)) return { changed: false, next: body };

  const minTokens = getMinClaudeMaxTokensForUpstreamThinkingBudget((body as any).reasoning_effort);
  const limit = getNumericTokenLimit(body);
  if (limit === null || limit >= minTokens) return { changed: false, next: body };

  const next: Record<string, unknown> = { ...body };
  if (typeof (body as any).max_completion_tokens === "number") {
    (next as any).max_completion_tokens = minTokens;
  } else if (typeof (body as any).max_tokens === "number") {
    (next as any).max_tokens = minTokens;
  } else {
    // Fallback: preserve behavior by setting max_tokens if the caller used an unknown field.
    (next as any).max_tokens = minTokens;
  }

  return { changed: true, next };
}

function hasToolUseHistoryInOpenAIChat(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role === "tool" || role === "function") return true;
    if (role === "assistant") {
      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;
      const functionCall = (msg as any).function_call;
      if (isRecord(functionCall) && typeof functionCall.name === "string" && functionCall.name) return true;
    }
  }
  return false;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const t = (item as any).type;
    if (t === "text" && typeof (item as any).text === "string") {
      parts.push((item as any).text);
      continue;
    }
    // Best-effort fallback for non-text parts (avoid dropping important context).
    parts.push(JSON.stringify(item));
  }
  return parts.join("");
}

type ToolCallInfo = { name: string; arguments: string };

function extractToolCallMap(messages: Array<Record<string, unknown>>): Map<string, ToolCallInfo> {
  const map = new Map<string, ToolCallInfo>();
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    if (msg.role !== "assistant") continue;
    const toolCalls = (msg as any).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const id = typeof (tc as any).id === "string" ? (tc as any).id : "";
      const name = typeof (tc as any).function?.name === "string" ? (tc as any).function.name : "";
      const args = typeof (tc as any).function?.arguments === "string" ? (tc as any).function.arguments : "";
      if (id) map.set(id, { name, arguments: args || "{}" });
    }
  }
  return map;
}

function flattenToolHistoryToText(
  body: Record<string, unknown>,
): { changed: boolean; next: Record<string, unknown> } {
  const messagesRaw = body.messages;
  if (!Array.isArray(messagesRaw)) return { changed: false, next: body };
  const messages = messagesRaw.filter(isRecord);
  if (messages.length === 0) return { changed: false, next: body };

  const toolCallMap = extractToolCallMap(messages);

  let changed = false;
  const outMessages: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "";
    if (!role) continue;

    if (role === "tool") {
      const toolCallId = typeof (msg as any).tool_call_id === "string" ? (msg as any).tool_call_id : "";
      const info = toolCallId ? toolCallMap.get(toolCallId) : undefined;
      const resultText = contentToText((msg as any).content);

      outMessages.push({
        role: "user",
        content: [info?.name ? `Tool result: ${info.name}` : "Tool result", info?.arguments ? `Arguments: ${info.arguments}` : "", resultText]
          .filter(Boolean)
          .join("\n")
          .trim(),
      });
      changed = true;
      continue;
    }

    if (role === "assistant") {
      // Drop tool_calls from history entirely; keep only textual content (if any).
      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const text = contentToText((msg as any).content);
        if (text) outMessages.push({ role: "assistant", content: text });
        changed = true;
        continue;
      }
    }

    // Keep message as-is (but normalize content arrays to string to reduce ambiguity).
    const nextMsg: Record<string, unknown> = { ...msg };
    if (Array.isArray((nextMsg as any).content)) {
      (nextMsg as any).content = contentToText((nextMsg as any).content);
      changed = true;
    }
    outMessages.push(nextMsg);
  }

  if (!changed) return { changed: false, next: body };
  return { changed: true, next: { ...body, messages: outMessages } };
}

function applyToolUseThinkingPolicy(
  body: Record<string, unknown>,
  policy: "disable" | "flatten" | "auto",
): { changed: boolean; next: Record<string, unknown> } {
  if (!hasToolUseHistoryInOpenAIChat(body)) return { changed: false, next: body };

  // Since some upstreams validate tool history strictly when thinking is enabled,
  // the most robust option is always to remove structured tool history.
  // (Policy is kept for compatibility; "disable"/"auto" currently behave the same.)
  void policy;
  return flattenToolHistoryToText(body);
}

function hasFunctionToolNamed(tools: unknown, names: string[]): boolean {
  if (!Array.isArray(tools)) return false;
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if ((t as any).type !== "function") continue;
    const name = (t as any).function?.name;
    if (typeof name !== "string") continue;
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) return true;
  }
  return false;
}

function removeFunctionToolsNamed(tools: unknown, names: string[]): { changed: boolean; next?: unknown } {
  if (!Array.isArray(tools)) return { changed: false, next: tools };
  const lowered = new Set(names.map((n) => n.toLowerCase()));
  const next = tools.filter((t) => {
    if (!t || typeof t !== "object") return true;
    if ((t as any).type !== "function") return true;
    const name = (t as any).function?.name;
    if (typeof name !== "string") return true;
    return !lowered.has(name.toLowerCase());
  });
  if (next.length === tools.length) return { changed: false, next: tools };
  return { changed: true, next: next.length > 0 ? next : undefined };
}

function ensureWebSearchOptionsWhenWebSearchToolPresent(
  body: Record<string, unknown>,
): { changed: boolean; next: Record<string, unknown> } {
  const hasWebSearchTool = hasFunctionToolNamed(body.tools, ["WebSearch"]);
  if (!hasWebSearchTool) return { changed: false, next: body };

  // NOTE: Hicap's OpenAI `web_search_options` does not appear to enable web search for Claude
  // models (observed: Claude responds it can't browse). In that case, removing the client-side
  // `WebSearch` tool makes the model fall back to other tools like `Execute`/`FetchUrl`.
  //
  // For Claude, keep the original `WebSearch` tool so the client (Droid) can execute it.
  if (looksLikeClaudeModel(body.model)) return { changed: false, next: body };

  let changed = false;
  let next: Record<string, unknown> = body;

  // Prefer upstream web_search_options over the client-side WebSearch tool.
  const removed = removeFunctionToolsNamed(next.tools, ["WebSearch"]);
  if (removed.changed) {
    next = { ...next, tools: removed.next as any };
    changed = true;
  }

  if (!isRecord((next as any).web_search_options)) {
    next = {
      ...next,
      web_search_options: {
        search_context_size: "low",
        user_location: { type: "approximate" },
      },
    };
    changed = true;
  }

  return { changed, next };
}

function rewriteOpenAIChatCompletionsRequestBody(
  body: Record<string, unknown>,
  toolUseThinkingPolicy: "disable" | "flatten" | "auto",
): { changed: boolean; next: Record<string, unknown> } {
  let changed = false;
  let next = body;

  const webSearch = ensureWebSearchOptionsWhenWebSearchToolPresent(next);
  if (webSearch.changed) {
    next = webSearch.next;
    changed = true;
  }

  const toolPolicy = applyToolUseThinkingPolicy(next, toolUseThinkingPolicy);
  if (toolPolicy.changed) {
    next = toolPolicy.next;
    changed = true;
  }

  const minTokens = ensureClaudeMinMaxTokens(next);
  if (minTokens.changed) {
    next = minTokens.next;
    changed = true;
  }

  return { changed, next };
}

/**
 * Create plugin:
 * - Request: Anthropic Messages API -> OpenAI Chat Completions
 * - Response: OpenAI Chat Completions -> Anthropic Messages API
 */
export function createDroidPlugin(options: DroidPluginOptions = {}): ProxyPlugin<Store> {
  const { debug, logDir } = options;
  const toolUseThinkingPolicy = options.toolUseThinkingPolicy ?? "auto";

  const logger: PluginLogger = createLogger({
    name: "chat4droid",
    debug,
    logDir,
  });

  return {
    name: "chat4droid",
    storeSchema: StoreSchema,

    shouldProcessRequest(meta: RequestMeta): PrecheckResult {
      const headers = normalizeHeaders(meta.headers) ?? {};
      if (!isJsonContentType(headers["content-type"])) return false;
      // Buffer only endpoints we may rewrite:
      // - /messages: Anthropic -> OpenAI
      // - /chat/completions: sanitize OpenAI requests for Bedrock/Claude constraints
      return urlEndsWithMessages(meta.url) || urlEndsWithChatCompletions(meta.url) ? true : false;
    },

    shouldProcessResponse(meta: ResponseMeta, requestMeta?: RequestMeta): PrecheckResult {
      const reqHeaders = normalizeHeaders(requestMeta?.headers) ?? {};
      // Convert when:
      // - request hook activated the store (Anthropic -> OpenAI rewrite)
      // - OR the caller is Anthropic SDK (anthropic-version/beta present)
      const storeActivated = hasActivatedStoreHeader(reqHeaders);
      const looksAnthropicCaller = Boolean(reqHeaders["anthropic-version"] || reqHeaders["anthropic-beta"]);
      if (!storeActivated && !looksAnthropicCaller) return false;

      const resHeaders = normalizeHeaders(meta.headers) ?? {};
      const ct = resHeaders["content-type"] ?? "";
      if (isJsonContentType(ct) || isEventStreamContentType(ct)) return true;
      return false;
    },

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      const headers = normalizeHeaders(params.meta.headers) ?? {};

      if (!isJsonContentType(headers["content-type"])) return null;

      const bodyBuffer = await readStreamToBuffer(params.body);
      const bodyText = bodyBuffer.toString("utf-8");
      const parsed = safeParseJson(bodyText);

      const isMessagesEndpoint = urlEndsWithMessages(params.meta.url);
      const isChatCompletionsEndpoint = urlEndsWithChatCompletions(params.meta.url);
      const looksAnthropicCaller = Boolean(headers["anthropic-version"] || headers["anthropic-beta"]);

      // Anthropic SDK callers may be routed to an OpenAI upstream (e.g. /v1/chat/completions).
      // In that case, the URL alone is not sufficient to determine the request format.
      if (isAnthropicMessagesRequest(parsed) && (isMessagesEndpoint || looksAnthropicCaller)) {
        const { url, body, headers: nextHeaders } = rewriteRequest({
          headers,
          url: params.meta.url ?? "",
          body: parsed,
        });

        // After converting Anthropic -> OpenAI request, reuse the same sanitizer we apply to
        // native OpenAI chat.completions requests (tool history, Claude token limits, etc).
        let finalBody = body;
        const parsedOpenAI = safeParseJson(body);
        if (looksLikeOpenAIChatCompletionsRequest(parsedOpenAI)) {
          const sanitized = rewriteOpenAIChatCompletionsRequestBody(parsedOpenAI, toolUseThinkingPolicy);
          if (sanitized.changed) finalBody = JSON.stringify(sanitized.next);
        }

        if (debug) {
          logger.logToFile("request-rewrite", {
            original: {
              url: params.meta.url,
              headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "authorization" && k !== "api-key")),
            },
            rewritten: {
              url,
              headers: Object.fromEntries(
                Object.entries(nextHeaders).filter(([k]) => k !== "authorization" && k !== "api-key"),
              ),
            },
          });
        }

        const finalHeaders = params.store ? params.store.set({ activated: true }, nextHeaders) : nextHeaders;

        return {
          meta: { method: "POST", url, headers: finalHeaders },
          body: streamFromBuffer(Buffer.from(finalBody, "utf-8")),
        };
      }

      if (isChatCompletionsEndpoint && looksLikeOpenAIChatCompletionsRequest(parsed)) {
        const { changed, next } = rewriteOpenAIChatCompletionsRequestBody(parsed, toolUseThinkingPolicy);
        if (!changed) return null;

        logger.debug(`Sanitized OpenAI chat.completions request (${toolUseThinkingPolicy})`);
        return {
          body: streamFromBuffer(Buffer.from(JSON.stringify(next), "utf-8")),
        };
      }

      logger.debug("Not a supported /messages or /chat/completions JSON request, skipping");
      return null;
    },

    async onResponse(params: ResponseHookParams<Store>): Promise<ResponseHookResult | null> {
      const store = params.store?.get();
      if (!store?.activated) return null;

      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const contentType = headers["content-type"] ?? "";

      if (isEventStreamContentType(contentType)) {
        logger.debug("Converting OpenAI chat.completions SSE to Anthropic SSE");
        return {
          meta: { headers: { ...(params.meta.headers ?? {}), "content-type": "text/event-stream; charset=utf-8" } },
          body: convertChatCompletionSSEToAnthropicSSEStream(params.body),
        };
      }

      if (isJsonContentType(contentType)) {
        const bodyBuffer = await readStreamToBuffer(params.body);
        const bodyText = bodyBuffer.toString("utf-8");

        const converted = convertChatCompletionResponseToAnthropicMessage(bodyText);
        return {
          meta: { headers: { ...(params.meta.headers ?? {}), ...(converted.headers ?? {}) } },
          body: streamFromBuffer(Buffer.from(converted.body, "utf-8")),
        };
      }

      return null;
    },
  };
}
