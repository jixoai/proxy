import { describe, it, expect } from "bun:test";
import {
  isUpstreamRequestFailedError,
  buildContextLengthExceededBody,
  looksLikeSse,
  extractJsonFromSseError,
  rewriteResponse,
} from "../response-rewriter";

describe("isUpstreamRequestFailedError", () => {
  it("should return true for valid upstream request failed error", () => {
    const error = {
      type: "error",
      error: {
        code: 400,
        type: "server_error",
        message: "Upstream request failed",
      },
    };
    expect(isUpstreamRequestFailedError(error)).toBe(true);
  });

  it("should return true when code is string '400'", () => {
    const error = {
      type: "error",
      error: {
        code: "400",
        type: "server_error",
        message: "Upstream request failed",
      },
    };
    expect(isUpstreamRequestFailedError(error)).toBe(true);
  });

  it("should return false for different error code", () => {
    const error = {
      type: "error",
      error: {
        code: 500,
        type: "server_error",
        message: "Upstream request failed",
      },
    };
    expect(isUpstreamRequestFailedError(error)).toBe(false);
  });

  it("should return false for different error type", () => {
    const error = {
      type: "error",
      error: {
        code: 400,
        type: "client_error",
        message: "Upstream request failed",
      },
    };
    expect(isUpstreamRequestFailedError(error)).toBe(false);
  });

  it("should return false for different message", () => {
    const error = {
      type: "error",
      error: {
        code: 400,
        type: "server_error",
        message: "Something else",
      },
    };
    expect(isUpstreamRequestFailedError(error)).toBe(false);
  });

  it("should return false for non-error type", () => {
    const obj = {
      type: "message",
      content: "hello",
    };
    expect(isUpstreamRequestFailedError(obj)).toBe(false);
  });

  it("should return false for null/undefined", () => {
    expect(isUpstreamRequestFailedError(null)).toBe(false);
    expect(isUpstreamRequestFailedError(undefined)).toBe(false);
  });
});

describe("buildContextLengthExceededBody", () => {
  it("should return correct structure", () => {
    const body = buildContextLengthExceededBody();

    expect(body.type).toBe("error");
    expect(body.message).toBe("context length exceeded");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBe(0);
  });
});

describe("looksLikeSse", () => {
  it("should return true for event: prefix", () => {
    expect(looksLikeSse("event: message\ndata: hello")).toBe(true);
  });

  it("should return true for data: prefix", () => {
    expect(looksLikeSse("data: hello")).toBe(true);
  });

  it("should return true for text containing \\ndata:", () => {
    expect(looksLikeSse("some text\ndata: value")).toBe(true);
  });

  it("should return false for plain text", () => {
    expect(looksLikeSse("just plain text")).toBe(false);
  });

  it("should return false for JSON", () => {
    expect(looksLikeSse('{"key": "value"}')).toBe(false);
  });
});

describe("extractJsonFromSseError", () => {
  it("should extract JSON from SSE error event", () => {
    const sse = `event: error\ndata: {"type":"error","error":{"code":400,"type":"server_error","message":"Upstream request failed"}}`;
    const result = extractJsonFromSseError(sse);

    expect(result).not.toBeNull();
    expect((result as any).type).toBe("error");
  });

  it("should return null for non-error events", () => {
    const sse = `event: message\ndata: {"content":"hello"}`;
    const result = extractJsonFromSseError(sse);

    expect(result).toBeNull();
  });

  it("should return null for invalid JSON in data", () => {
    const sse = `event: error\ndata: not json`;
    const result = extractJsonFromSseError(sse);

    expect(result).toBeNull();
  });

  it("should handle multi-line data", () => {
    const sse = `event: error\ndata: {\ndata: "type":"error"\ndata: }`;
    const result = extractJsonFromSseError(sse);

    expect(result).not.toBeNull();
  });
});

describe("rewriteResponse", () => {
  it("should rewrite upstream request failed error (JSON)", () => {
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
    });

    expect(result.rewritten).toBe(true);
    expect(result.source).toBe("json");
    expect(result.meta.statusCode).toBe(400);

    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    expect(rewrittenBody.error.code).toBe("context_length_exceeded");
  });

  it("should rewrite upstream request failed error (SSE)", () => {
    const sse = `event: error\ndata: {"type":"error","error":{"code":400,"type":"server_error","message":"Upstream request failed"}}`;

    const result = rewriteResponse({
      meta: {
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
      },
      body: Buffer.from(sse),
    });

    expect(result.rewritten).toBe(true);
    expect(result.source).toBe("sse");
  });

  it("should not rewrite normal response", () => {
    const body = JSON.stringify({
      type: "message",
      content: "Hello!",
    });

    const result = rewriteResponse({
      meta: {
        statusCode: 200,
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
    });

    expect(result.rewritten).toBe(false);
  });

  it("should not rewrite empty body", () => {
    const result = rewriteResponse({
      meta: { statusCode: 200 },
      body: Buffer.from(""),
    });

    expect(result.rewritten).toBe(false);
  });

  it("should not rewrite different error", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        code: 401,
        type: "authentication_error",
        message: "Invalid API key",
      },
    });

    const result = rewriteResponse({
      meta: {
        statusCode: 401,
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
    });

    expect(result.rewritten).toBe(false);
  });

  it("should preserve original headers with updated content-type", () => {
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
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "abc123",
        },
      },
      body: Buffer.from(body),
    });

    expect(result.rewritten).toBe(true);
    expect(result.meta.headers?.["content-type"]).toBe("application/json; charset=utf-8");
    expect(result.meta.headers?.["x-request-id"]).toBe("abc123");
  });

  it("should rewrite 200+context_length_exceeded to 500 server anomaly for small request", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        code: "context_length_exceeded",
        type: "invalid_request_error",
        message: "context length exceeded",
      },
    });

    const result = rewriteResponse({
      meta: {
        statusCode: 200,
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
      requestContentLength: 123, // small
      serverAnomalyThreshold: 680 * 1024,
    });

    expect(result.rewritten).toBe(true);
    expect(result.source).toBe("server_anomaly");
    expect(result.meta.statusCode).toBe(500);

    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    expect(rewrittenBody.error.code).toBe("server_anomaly");
  });

  it("should rewrite 200+context_length_exceeded to 400 for large request", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        code: "context_length_exceeded",
        type: "invalid_request_error",
        message: "context length exceeded",
      },
    });

    const result = rewriteResponse({
      meta: {
        statusCode: 200,
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
      requestContentLength: 681 * 1024, // >= threshold, not anomaly
      serverAnomalyThreshold: 680 * 1024,
    });

    expect(result.rewritten).toBe(true);
    expect(result.source).toBe("json");
    expect(result.meta.statusCode).toBe(400);

    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    expect(rewrittenBody.error.code).toBe("context_length_exceeded");
    expect(rewrittenBody.error.type).toBe("invalid_request_error");
  });

  it("should rewrite 200+context_length_exceeded to 400 even without requestContentLength", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        code: "context_length_exceeded",
        type: "invalid_request_error",
        message: "context length exceeded",
      },
    });

    const result = rewriteResponse({
      meta: {
        statusCode: 200,
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
      // requestContentLength omitted
      serverAnomalyThreshold: 680 * 1024,
    });

    expect(result.rewritten).toBe(true);
    expect(result.meta.statusCode).toBe(400);

    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    expect(rewrittenBody.error.code).toBe("context_length_exceeded");
  });
});
