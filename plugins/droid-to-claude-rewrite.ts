#!/usr/bin/env bun
/**
 * Droid-CLI to Claude-Code-CLI request rewrite hook (HTTP version)
 *
 * Protocol:
 *   - Receives binary body: head-len(uint32be) + JSON meta + raw body
 *   - Exposes POST /hook-req-requestBody and /hook-res-requestBody
 *   - Reports listening URL via POST __CALLBACK_URL__ with plain text body
 */

import * as fs from "node:fs";
import * as path from "node:path";

type CacheControl = { type: "ephemeral" };

type TextBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
};

type MessageRole = "user" | "assistant" | "system" | "tool";

type Message = {
  role: MessageRole;
  content?: string | TextBlock[];
};

type ToolParamSchema = { description?: string };

type Tool = {
  name: string;
  description?: string;
  input_schema?: { properties?: Record<string, ToolParamSchema> };
};

type RequestBody = {
  model?: string;
  system?: string | TextBlock[];
  messages?: Message[];
  tools?: Tool[];
  metadata?: Record<string, unknown>;
  max_tokens?: number;
  stream?: boolean;
};

type RewriteParams = {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
};

type RequestMeta = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
};

type ResponseMeta = {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
};

const __dirname = import.meta.dirname;
const LOG_DIR = path.join(__dirname, "./.tmp/hook-logs");
const HEAD_LEN_BYTES = 4;

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

let requestCounter = 0;

function logToFile(prefix: string, data: unknown) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}_${requestCounter}_${prefix}.json`;
  const filepath = path.join(LOG_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.error(`[droid-to-claude] Logged to: ${filename}`);
}

function encodeEnvelope(meta: unknown, body: Uint8Array): Buffer {
  const metaBuffer = Buffer.from(JSON.stringify(meta ?? {}), "utf-8");
  const lenBuffer = Buffer.alloc(HEAD_LEN_BYTES);
  lenBuffer.writeUInt32BE(metaBuffer.length, 0);
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([lenBuffer, metaBuffer, bodyBuffer]);
}

function decodeEnvelope(buffer: Buffer): { meta: unknown; body: Buffer } {
  if (buffer.length < HEAD_LEN_BYTES) {
    throw new Error("invalid envelope: missing head-len");
  }
  const headLen = buffer.readUInt32BE(0);
  if (buffer.length < HEAD_LEN_BYTES + headLen) {
    throw new Error("invalid envelope: head-len mismatch");
  }
  const metaBuffer = buffer.subarray(HEAD_LEN_BYTES, HEAD_LEN_BYTES + headLen);
  const body = buffer.subarray(HEAD_LEN_BYTES + headLen);
  const metaJson = metaBuffer.toString("utf-8") || "{}";
  return { meta: JSON.parse(metaJson), body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHeaders(
  headers: unknown,
): Record<string, string> | undefined {
  if (!isRecord(headers)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.map(String).join(", ");
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function isDroidRequest(requestBody: RequestBody) {
  if (!requestBody.system) return false;

  const systemText = Array.isArray(requestBody.system)
    ? requestBody.system.map((s) => s.text || "").join(" ")
    : String(requestBody.system);

  return (
    systemText.includes("Droid") ||
    systemText.includes("Factory") ||
    systemText.includes("factory-droid")
  );
}

function extractSystemText(system: RequestBody["system"]) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((s) => ("text" in s ? s.text || "" : "")).join("\n\n");
}

function normalizeContentArray(message: Message | undefined) {
  if (!message) return;
  if (Array.isArray(message.content)) return;
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: message.content }];
    return;
  }
  message.content = [];
}

function replaceSystemReminderSection(
  originalText: string,
  newReminderText: string,
) {
  const startTag = "<system-reminder>";
  const endTag = "</system-reminder>";
  const start = originalText.indexOf(startTag);
  const end = originalText.lastIndexOf(endTag);
  if (start === -1 || end === -1 || end <= start) return null;

  const before = originalText.slice(0, start);
  const after = originalText.slice(end + endTag.length);
  return `${before}${newReminderText}${after}`;
}

function mergeDuplicateSystemReminders(messages: Message[] | undefined) {
  if (!Array.isArray(messages)) return false;
  let merged = false;
  let i = 0;
  while (i < messages.length - 1) {
    const first = messages[i];
    const second = messages[i + 1];
    if (first?.role !== "user" || second?.role !== "user") {
      i += 1;
      continue;
    }

    normalizeContentArray(first);
    normalizeContentArray(second);

    const firstContent = Array.isArray(first.content)
      ? first.content
      : undefined;
    const secondContent = Array.isArray(second.content)
      ? second.content
      : undefined;
    if (!firstContent || !secondContent) {
      i += 1;
      continue;
    }

    const firstSysIndex = firstContent.findIndex(
      (c) =>
        c?.type === "text" &&
        typeof c.text === "string" &&
        c.text.includes("<system-reminder>"),
    );

    const secondSysTexts = secondContent
      .filter(
        (c) =>
          c?.type === "text" &&
          typeof c.text === "string" &&
          c.text.includes("<system-reminder>"),
      )
      .map((c) => c.text);

    if (firstSysIndex !== -1 && secondSysTexts.length > 0) {
      const target = firstContent[firstSysIndex];
      if (target?.text) {
        const replacement = replaceSystemReminderSection(
          target.text,
          secondSysTexts.join("\n\n"),
        );
        if (replacement) {
          target.text = replacement;
          messages.splice(i + 1, 1);
          merged = true;
          continue;
        }
      }
    }

    i += 1;
  }
  return merged;
}

function safeParseJSON(str: string) {
  try {
    return JSON.parse(str);
  } catch {
    return { parseError: true, preview: str.substring(0, 500) };
  }
}

function rewriteRequest(params: RewriteParams) {
  requestCounter += 1;
  const { method, url, headers = {}, body } = params;
  const decodedBody = body || "";

  logToFile("1-original-request", {
    method,
    url,
    headers,
    bodyParsed: decodedBody ? safeParseJSON(decodedBody) : null,
  });

  if (!decodedBody) {
    logToFile("2-no-body-skip", { reason: "no body provided" });
    return {} as const;
  }

  try {
    const requestBody = JSON.parse(decodedBody) as RequestBody;

    logToFile("3-parsed-body-structure", {
      model: requestBody.model,
      hasSystem: !!requestBody.system,
      systemType: Array.isArray(requestBody.system)
        ? "array"
        : typeof requestBody.system,
      systemPreview: Array.isArray(requestBody.system)
        ? requestBody.system.map((s) => s.text?.substring(0, 80) ?? "")
        : String(requestBody.system).substring(0, 200),
      messagesCount: requestBody.messages?.length,
      hasTools: !!requestBody.tools,
      toolsCount: requestBody.tools?.length,
      hasMetadata: !!requestBody.metadata,
      maxTokens: requestBody.max_tokens,
      stream: requestBody.stream,
    });

    if (!isDroidRequest(requestBody)) {
      logToFile("4-not-droid-skip", { reason: "not a droid request" });
      return {} as const;
    }

    console.error("[droid-to-claude] Detected droid request, rewriting...");

    const droidSystemText = extractSystemText(requestBody.system);
    logToFile("5-droid-system", {
      textLength: droidSystemText.length,
      preview: droidSystemText.substring(0, 200),
    });

    const claudeCodeSystem: TextBlock[] = [
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ];
    requestBody.system = claudeCodeSystem;

    const droidSystemContent: TextBlock = {
      type: "text",
      text: `<droid-system-context>\n${droidSystemText}\n</droid-system-context>`,
      cache_control: { type: "ephemeral" },
    };
    requestBody.system.push(droidSystemContent);

    const mergedSystemReminder = mergeDuplicateSystemReminders(
      requestBody.messages,
    );
    if (mergedSystemReminder) {
      logToFile("5b-system-reminder-merged", {
        messageCount: requestBody.messages?.length,
      });
    }

    if (requestBody.tools && requestBody.tools.length > 0) {
      logToFile("6-droid-tools-kept", {
        toolNames: requestBody.tools.map((t) => t.name),
        toolsCount: requestBody.tools.length,
      });
      console.error(
        `[droid-to-claude] Keeping original droid tools (${requestBody.tools.length} tools)`,
      );
    }

    if (!requestBody.metadata) {
      requestBody.metadata = {
        user_id:
          "user_8affcbe039c1380bd8de140015ef63dd4936d02ecd7d5a0f78af6ed95967c5c0_account__session_dffce60e-e7a0-4bc3-b847-4e25f13d3c66",
      };
    }
    logToFile("6d-metadata", { metadata: requestBody.metadata });

    const newBody = JSON.stringify(requestBody);

    const newHeaders: Record<string, string> = { ...headers };
    newHeaders["anthropic-beta"] =
      "claude-code-20250219,interleaved-thinking-2025-05-14";
    if (newHeaders["x-api-key"] && !newHeaders["authorization"]) {
      newHeaders["authorization"] = `Bearer ${newHeaders["x-api-key"]}`;
      delete newHeaders["x-api-key"];
    }
    newHeaders["x-app"] = "cli";
    newHeaders["anthropic-dangerous-direct-browser-access"] = "true";
    newHeaders["user-agent"] = "claude-cli/2.0.58 (external, cli)";

    logToFile("6c-modified-headers", {
      originalHeaders: Object.keys(headers),
      newHeaders: Object.keys(newHeaders),
      hasAnthropicBeta: !!newHeaders["anthropic-beta"],
      hasAuthorization: !!newHeaders["authorization"],
    });

    logToFile("7-modified-body", {
      model: requestBody.model,
      systemPreview: Array.isArray(requestBody.system)
        ? requestBody.system.map((s) => s.text?.substring(0, 80) ?? "")
        : String(requestBody.system).substring(0, 200),
      messagesCount: requestBody.messages?.length,
      hasTools: !!requestBody.tools,
      toolsCount: requestBody.tools?.length,
      hasMetadata: !!requestBody.metadata,
      bodyLength: newBody.length,
    });

    logToFile("8-modified-body-full", safeParseJSON(newBody));

    console.error("[droid-to-claude] Request rewritten successfully");
    return { headers: newHeaders, body: newBody } as const;
  } catch (e) {
    const error = e instanceof Error ? e : new Error("Unknown parse error");
    logToFile("error", { message: error.message, stack: error.stack });
    console.error("[droid-to-claude] Parse error:", error.message);
    return {} as const;
  }
}

function buildRequestResponse(
  meta: RequestMeta,
  body: Buffer,
  rewritten: ReturnType<typeof rewriteRequest>,
) {
  const nextHeaders = rewritten.headers ?? meta.headers ?? {};
  const nextBody =
    rewritten.body !== undefined ? Buffer.from(rewritten.body, "utf-8") : body;
  const nextMeta = {
    method: meta.method,
    url: meta.url,
    headers: nextHeaders,
  };
  return encodeEnvelope(nextMeta, nextBody);
}

function buildResponseEcho(meta: ResponseMeta, body: Buffer) {
  return encodeEnvelope(
    {
      statusCode: meta.statusCode,
      statusMessage: meta.statusMessage,
      headers: meta.headers,
    },
    body,
  );
}

async function start() {
  const callbackUrl = process.env.__CALLBACK_URL__;
  if (!callbackUrl) {
    console.error("[droid-to-claude] Missing __CALLBACK_URL__ env");
    process.exit(1);
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const url = new URL(req.url);
      const raw = Buffer.from(await req.arrayBuffer());

      try {
        const { meta, body } = decodeEnvelope(raw);

        if (url.pathname === "/hook-req-requestBody") {
          const normalizedMeta: RequestMeta = isRecord(meta) ? (meta as RequestMeta) : {};
          const headers = normalizeHeaders(normalizedMeta.headers) ?? {};
          const rewritten = rewriteRequest({
            method: normalizedMeta.method,
            url: normalizedMeta.url,
            headers,
            body: body.toString("utf-8"),
          });
          const payload = buildRequestResponse(
            { ...normalizedMeta, headers },
            body,
            rewritten,
          );
          const bodyInit = new Uint8Array(payload);
          return new Response(bodyInit, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        if (url.pathname === "/hook-res-requestBody") {
          const normalizedMeta: ResponseMeta = isRecord(meta) ? (meta as ResponseMeta) : {};
          const payload = buildResponseEcho(normalizedMeta, body);
          const bodyInit = new Uint8Array(payload);
          return new Response(bodyInit, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error("[droid-to-claude] Handler error", err);
        return new Response("Internal Error", { status: 500 });
      }
    },
  });

  const listenUrl = `http://127.0.0.1:${server.port}/`;
  await fetch(callbackUrl, { method: "POST", body: listenUrl });
  console.error(`[droid-to-claude] Listening on ${listenUrl}`);

  const stop = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

start().catch((err) => {
  console.error("[droid-to-claude] Fatal error:", err);
  process.exit(1);
});
