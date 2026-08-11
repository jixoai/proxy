/**
 * 正交意图：
 * 1. 在 Bun TLS 握手被特定上游重置时，使用 Node 的 TLS 客户端完成一次 HTTPS 请求。
 * 2. 将请求体、响应头和响应体以单次 JSON 边界传递给 Node 子进程。
 * 3. 支持父请求取消，并将子进程生命周期绑定到请求生命周期。
 * 原始需求输入（2026-08-12）：修复 aiweb.xin 在 Bun 代理中稳定返回 502 的问题。
 * 不可调和声明：Bun 运行时不能在同一进程内切换到 Node 的 TLS 实现，因此必须使用子进程隔离。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

export interface NodeHttpsRequestInput {
  url: string;
  method: string;
  headers: OutgoingHttpHeaders;
  body: Buffer;
}

export interface NodeHttpsResponse {
  statusCode: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  bodyBuffer: Buffer;
}

interface NodeHttpsBridgeSuccess {
  ok: true;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  bodyBase64: string;
}

interface NodeHttpsBridgeFailure {
  ok: false;
  error: string;
}

type NodeHttpsBridgeResult = NodeHttpsBridgeSuccess | NodeHttpsBridgeFailure;

const NODE_HTTPS_BRIDGE_SCRIPT = String.raw`
const https = require("node:https");
const inputChunks = [];
let resultWritten = false;

function writeResult(result) {
  if (resultWritten) return;
  resultWritten = true;
  process.stdout.write(JSON.stringify(result));
}

process.stdin.on("data", (chunk) => inputChunks.push(Buffer.from(chunk)));
process.stdin.on("error", (error) => writeResult({ ok: false, error: error.message }));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(Buffer.concat(inputChunks).toString("utf8"));
    const target = new URL(input.url);
    const request = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: input.method,
        headers: input.headers,
      },
      (response) => {
        const responseChunks = [];
        response.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
        response.on("error", (error) => writeResult({ ok: false, error: error.message }));
        response.on("end", () => {
          writeResult({
            ok: true,
            statusCode: response.statusCode || 502,
            statusMessage: response.statusMessage || "",
            headers: response.headers,
            bodyBase64: Buffer.concat(responseChunks).toString("base64"),
          });
        });
      },
    );
    request.on("error", (error) => writeResult({ ok: false, error: error.message }));
    const body = Buffer.from(input.bodyBase64, "base64");
    if (body.length > 0) request.write(body);
    request.end();
  } catch (error) {
    writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBridgeResult(value: unknown): NodeHttpsBridgeResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Node HTTPS bridge returned an invalid response");
  }
  if (!value.ok) {
    if (typeof value.error !== "string") {
      throw new Error("Node HTTPS bridge returned an unknown error");
    }
    return { ok: false, error: value.error };
  }

  const headers = value.headers;
  if (
    typeof value.statusCode !== "number" ||
    typeof value.statusMessage !== "string" ||
    !isRecord(headers) ||
    typeof value.bodyBase64 !== "string"
  ) {
    throw new Error("Node HTTPS bridge returned an invalid success response");
  }

  const normalizedHeaders: Record<string, string | string[] | undefined> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (
      typeof headerValue === "string" ||
      (Array.isArray(headerValue) && headerValue.every((item) => typeof item === "string"))
    ) {
      normalizedHeaders[name] = headerValue as string | string[];
    }
  }

  return {
    ok: true,
    statusCode: value.statusCode,
    statusMessage: value.statusMessage,
    headers: normalizedHeaders,
    bodyBase64: value.bodyBase64,
  };
}

function isTlsResetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return code === "ECONNRESET" || /socket connection was closed|socket hang up/i.test(error.message);
}

export function shouldUseNodeHttpsFallback(error: unknown, protocol: string): boolean {
  return protocol === "https:" && isTlsResetError(error);
}

function terminateProcess(child: ChildProcess): void {
  if (!child.killed) child.kill("SIGTERM");
}

/** 使用 Node 的 TLS 实现完成一次缓冲式 HTTPS 请求。 */
export function requestWithNodeHttpsFallback(
  input: NodeHttpsRequestInput,
  signal: AbortSignal,
): Promise<NodeHttpsResponse> {
  const runtime = process.env.PROXY_NODE_RUNTIME || "node";
  const child = spawn(runtime, ["-e", NODE_HTTPS_BRIDGE_SCRIPT], {
    stdio: ["pipe", "pipe", "ignore"],
  });

  return new Promise<NodeHttpsResponse>((resolve, reject) => {
    const outputChunks: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners();
      child.removeAllListeners("error");
      child.removeAllListeners("close");
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateProcess(child);
      reject(error);
    };

    const onAbort = () => fail(new Error("Node HTTPS fallback request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    child.on("error", (error) => fail(error));
    child.stdout?.on("data", (chunk: Buffer) => outputChunks.push(Buffer.from(chunk)));
    child.stdout?.on("end", () => {
      if (settled) return;
      try {
        const result = parseBridgeResult(JSON.parse(Buffer.concat(outputChunks).toString("utf8")));
        if (!result.ok) {
          fail(new Error(result.error));
          return;
        }
        settled = true;
        cleanup();
        resolve({
          statusCode: result.statusCode,
          statusMessage: result.statusMessage,
          headers: result.headers,
          bodyBuffer: Buffer.from(result.bodyBase64, "base64"),
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stdin?.on("error", (error) => fail(error));
    child.stdin?.end(
      JSON.stringify({
        url: input.url,
        method: input.method,
        headers: input.headers,
        bodyBase64: input.body.toString("base64"),
      }),
    );
  });
}
