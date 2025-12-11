#!/usr/bin/env bun
/**
 * Send an API v1 message request using a saved JSON body file.
 * Usage: bun ./scripts/req-api-v1-message.ts path/to/body.json
 */

import { readFile } from "fs/promises";
import path from "path";

const ANSI = {
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  reset: "\u001b[0m",
};

function expectArg(): string {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error(
      "Usage: bun ./scripts/req-api-v1-message.ts <body-json-path>",
    );
    process.exit(1);
  }
  return path.resolve(fileArg);
}

async function loadBody(filePath: string): Promise<string> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Body JSON must be an object");
  }
  return JSON.stringify(parsed);
}

function buildHeaders(apiKey: string): Record<string, string> {
  if (!apiKey) {
    console.error(
      `${ANSI.yellow}[warn] Missing API key. Set ANTHROPIC_API_KEY / X_API_KEY / API_KEY env.` +
        ANSI.reset,
    );
  }
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
    "user-agent": "claude-cli/2.0.58 (external, cli)",
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
    authorization: apiKey ? `Bearer ${apiKey}` : "",
  };
}

function headerEntries(headers: Headers): Array<[string, string]> {
  const list: Array<[string, string]> = [];
  headers.forEach((value, key) => list.push([key, value]));
  return list;
}

async function main(): Promise<void> {
  const filePath = expectArg();
  const body = await loadBody(filePath);

  const apiKey =
    process.env.ANTHROPIC_API_KEY ??
    process.env.X_API_KEY ??
    process.env.API_KEY ??
    "";
  const url =
    process.env.ANTHROPIC_URL ??
    process.env.BASE_URL ??
    "https://www.88code.org/api/v1/messages?beta=true";
  const method = process.env.HTTP_METHOD ?? "POST";

  const headers = buildHeaders(apiKey);

  console.error(`${ANSI.green}[info] POST ${url}${ANSI.reset}`);
  console.error(`${ANSI.green}[info] Body length: ${body.length}${ANSI.reset}`);

  const response = await fetch(url, {
    method,
    headers,
    body,
  });

  console.log(`HTTP ${response.status} ${response.statusText}`);
  for (const [key, value] of headerEntries(response.headers)) {
    console.log(`${key}: ${value}`);
  }
  console.log("");

  if (!response.body) {
    const text = await response.text();
    console.log(text);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      process.stdout.write(decoder.decode(value));
    }
  }
}

main().catch((err) => {
  console.error(
    `${ANSI.yellow}[error] ${err instanceof Error ? err.message : String(err)}${ANSI.reset}`,
  );
  process.exit(1);
});
