#!/usr/bin/env bun
/**
 * Auto-compact rewrite hook (response only)
 *
 * Purpose:
 * - When upstream returns: { type:"error", error:{ code:400, type:"server_error", message:"Upstream request failed" } }
 * - Rewrite it into an Anthropic-style "context_length_exceeded" error so Droid can auto-compact and retry.
 *
 * Protocol:
 * - Receives binary body: head-len(uint32be) + JSON meta + raw body
 * - Exposes POST /hook-req-requestBody and /hook-res-requestBody
 * - Reports listening URL via POST __CALLBACK_URL__ with plain text body
 */

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

type ResponseMeta = {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
};

type RequestMeta = {
  method?: string;
  url?: string;
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
  requestCounter += 1;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}_${requestCounter}_${prefix}.json`;
  fs.writeFileSync(path.join(LOG_DIR, filename), JSON.stringify(data, null, 2));
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

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!isRecord(headers)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (typeof value === "string") {
      result[normalizedKey] = value;
    } else if (Array.isArray(value)) {
      result[normalizedKey] = value.map(String).join(", ");
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function isJsonContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes("application/json") || normalized.includes("+json");
}

function isEventStreamContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes("text/event-stream");
}

function safeParseJSON(str: string) {
  try {
    return JSON.parse(str);
  } catch {
    return { parseError: true, preview: str.substring(0, 500) };
  }
}

function isUpstreamRequestFailedError(parsed: unknown): parsed is {
  type: "error";
  error: { code: number | string; type: string; message: string };
} {
  if (!isRecord(parsed)) return false;
  if (parsed.type !== "error") return false;
  if (!isRecord(parsed.error)) return false;
  const upstreamError = parsed.error;
  const upstreamCode = upstreamError.code;
  if (upstreamCode !== 400 && upstreamCode !== "400") return false;
  if (upstreamError.type !== "server_error") return false;
  if (upstreamError.message !== "Upstream request failed") return false;
  return true;
}

function buildContextLengthExceededBody() {
  return {
    type: "error",
    message: "context length exceeded",
    error: {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: "context length exceeded",
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksLikeSse(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  return head.startsWith("event:") || head.startsWith("data:") || head.includes("\ndata:");
}

function extractJsonFromSseError(text: string): unknown | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const field = line.slice(0, idx).trim();
      let value = line.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      if (field === "data") dataLines.push(value);
    }
    if (eventName !== "error" || dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    const trimmed = data.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    const parsed = tryParseJson(data);
    if (parsed) return parsed;
  }
  return null;
}

function rewriteResponse(params: { meta: ResponseMeta; body: Buffer }): { meta: ResponseMeta; body: Buffer } {
  const headers = normalizeHeaders(params.meta.headers) ?? {};
  const contentType = headers["content-type"];
  const text = params.body.toString("utf-8");
  if (!text.trim()) return params;

  const directParsed =
    isJsonContentType(contentType) || text.trimStart().startsWith("{") ? tryParseJson(text) : null;
  const sseParsed =
    directParsed ? null : isEventStreamContentType(contentType) || looksLikeSse(text) ? extractJsonFromSseError(text) : null;
  const parsed = directParsed ?? sseParsed;
  if (!isUpstreamRequestFailedError(parsed)) return params;

  const rewrittenBody = buildContextLengthExceededBody();

  const nextMeta: ResponseMeta = {
    statusCode: 400,
    statusMessage: "Bad Request",
    headers: {
      ...(params.meta.headers ?? {}),
      "content-type": "application/json; charset=utf-8",
    },
  };
  const nextBody = Buffer.from(JSON.stringify(rewrittenBody), "utf-8");

  logToFile("auto-compact-rewrite", {
    originalMeta: params.meta,
    originalBody: safeParseJSON(text),
    rewrittenMeta: nextMeta,
    rewrittenBody,
    source: directParsed ? "json" : "sse",
  });

  return { meta: nextMeta, body: nextBody };
}

async function start() {
  const callbackUrl = process.env.__CALLBACK_URL__;
  if (!callbackUrl) {
    console.error("Missing __CALLBACK_URL__ env");
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
          // Pass-through for request stage.
          const payload = encodeEnvelope(
            {
              method: normalizedMeta.method,
              url: normalizedMeta.url,
              headers: normalizedMeta.headers,
            },
            body,
          );
          return new Response(new Uint8Array(payload), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        if (url.pathname === "/hook-res-requestBody") {
          const normalizedMeta: ResponseMeta = isRecord(meta) ? (meta as ResponseMeta) : {};
          const rewritten = rewriteResponse({ meta: normalizedMeta, body });
          const payload = encodeEnvelope(
            {
              statusCode: rewritten.meta.statusCode,
              statusMessage: rewritten.meta.statusMessage,
              headers: rewritten.meta.headers,
            },
            rewritten.body,
          );
          return new Response(new Uint8Array(payload), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error("Handler error", err);
        return new Response("Internal Error", { status: 500 });
      }
    },
  });

  const listenUrl = `http://127.0.0.1:${server.port}/`;
  await fetch(callbackUrl, { method: "POST", body: listenUrl });
  console.log(`Listening on ${listenUrl}`);

  const stop = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
