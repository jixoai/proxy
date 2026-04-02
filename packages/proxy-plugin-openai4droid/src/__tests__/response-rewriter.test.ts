import { describe, expect, it } from "bun:test";
import { rewriteResponse } from "../response-rewriter";

describe("rewriteResponse", () => {
  it("rewrites upstream request failed JSON to context_length_exceeded", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        code: 400,
        type: "server_error",
        message: "Upstream request failed",
      },
    });

    const result = rewriteResponse({
      meta: {
        statusCode: 400,
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
      requestContentLength: 120000,
      serverAnomalyThreshold: 10000,
    });

    expect(result.rewritten).toBe(true);
    expect(result.meta.statusCode).toBe(400);
    expect(result.source).toBe("json");

    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    expect(rewrittenBody.error.code).toBe("context_length_exceeded");
  });

  it("rewrites response.failed SSE to context_length_exceeded", () => {
    const body = [
      "event: response.failed",
      'data: {"type":"response.failed","response":{"id":"resp_test","status":"failed","error":{"code":"server_error","message":"Upstream request failed"}}}',
      "",
    ].join("\n");

    const result = rewriteResponse({
      meta: {
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
      },
      body: Buffer.from(body),
      requestContentLength: 120000,
      serverAnomalyThreshold: 10000,
    });

    expect(result.rewritten).toBe(true);
    expect(result.meta.statusCode).toBe(400);
    expect(result.source).toBe("sse");

    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    expect(rewrittenBody.error.code).toBe("context_length_exceeded");
  });

  it("rewrites empty 502 gateway response to context_length_exceeded for large request", () => {
    const result = rewriteResponse({
      meta: {
        statusCode: 502,
        statusMessage: "Bad Gateway",
      },
      body: Buffer.from(""),
      requestContentLength: 150000,
      serverAnomalyThreshold: 10000,
    });

    expect(result.rewritten).toBe(true);
    expect(result.meta.statusCode).toBe(400);
    expect(result.source).toBe("gateway_empty");

    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    expect(rewrittenBody.error.code).toBe("context_length_exceeded");
  });

  it("rewrites empty 502 gateway response to server_anomaly for small request", () => {
    const result = rewriteResponse({
      meta: {
        statusCode: 502,
        statusMessage: "Bad Gateway",
      },
      body: Buffer.from(""),
      requestContentLength: 512,
      serverAnomalyThreshold: 10000,
    });

    expect(result.rewritten).toBe(true);
    expect(result.meta.statusCode).toBe(500);
    expect(result.source).toBe("gateway_empty");

    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    expect(rewrittenBody.error.code).toBe("server_anomaly");
  });

  it("does not rewrite empty body for non-gateway status", () => {
    const result = rewriteResponse({
      meta: {
        statusCode: 200,
      },
      body: Buffer.from(""),
    });

    expect(result.rewritten).toBe(false);
  });
});
