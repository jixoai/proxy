import { describe, expect, it } from "bun:test";
import { createDroidPlugin } from "../plugin";
import { createMockStore, readStreamToBuffer, streamFromBuffer } from "@jixo/proxy-plugin";

describe("createDroidPlugin.shouldProcessResponse", () => {
  const plugin = createDroidPlugin();
  const shouldProcessResponse = plugin.shouldProcessResponse!;
  const pluginWith499Rewrite = createDroidPlugin({ rewrite499ToContextLengthExceeded: true });
  const shouldProcessResponseWith499Rewrite = pluginWith499Rewrite.shouldProcessResponse!;

  const requestMeta = {
    method: "POST",
    url: "http://example.com/openai-droid/responses",
    headers: { "content-type": "application/json" },
  };

  it("processes gateway error responses even without content-type", () => {
    const result = shouldProcessResponse(
      {
        statusCode: 502,
        headers: {},
      },
      requestMeta,
    );

    expect(result).toBe(true);
  });

  it("skips non-json and non-sse success responses", () => {
    const result = shouldProcessResponse(
      {
        statusCode: 200,
        headers: { "content-type": "text/plain" },
      },
      requestMeta,
    );

    expect(result).toBe(false);
  });

  it("processes 499 responses when 499 rewrite is enabled", () => {
    const result = shouldProcessResponseWith499Rewrite(
      {
        statusCode: 499,
        headers: {},
      },
      requestMeta,
    );

    expect(result).toBe(true);
  });

  it("skips 499 responses by default", () => {
    const result = shouldProcessResponse(
      {
        statusCode: 499,
        headers: {},
      },
      requestMeta,
    );

    expect(result).toBe(false);
  });
});

describe("createDroidPlugin.onResponse", () => {
  it("rewrites 499 responses to context_length_exceeded when enabled", async () => {
    const plugin = createDroidPlugin({ rewrite499ToContextLengthExceeded: true });
    const result = await plugin.onResponse!({
      meta: {
        statusCode: 499,
        headers: {},
      },
      body: streamFromBuffer(Buffer.alloc(0)),
      store: createMockStore({
        activated: true as const,
        requestBodyLength: 950_000,
        requestKind: "standard" as const,
      }),
    });

    expect(result).not.toBeNull();
    expect(!("modified" in result!) || result!.modified !== false).toBe(true);

    const modifiedResult = result as {
      meta?: { statusCode?: number };
      body?: ReadableStream<Uint8Array>;
    };

    expect(modifiedResult.meta?.statusCode).toBe(400);

    const parsedBody = JSON.parse((await readStreamToBuffer(modifiedResult.body!)).toString("utf-8"));
    expect(parsedBody.error.code).toBe("context_length_exceeded");
  });
});

describe("createDroidPlugin.onRequest", () => {
  it("preserves native summarizer requests while enabling SSE and adding session headers", async () => {
    const plugin = createDroidPlugin();
    const originalBody = {
      model: "gpt-5.4",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. You excel at creating and maintaining summaries that capture the most salient details from technical conversations.",
      input: "Please summarize the following conversation:\\n```\\nUSER: hello\\n```",
      max_output_tokens: 4000,
      store: false,
    };

    const result = await plugin.onRequest!({
      meta: {
        method: "POST",
        url: "http://example.com/openai-droid/responses",
        headers: { "content-type": "application/json" },
      },
      body: streamFromBuffer(Buffer.from(JSON.stringify(originalBody), "utf-8")),
      store: createMockStore(),
    });

    expect(result).not.toBeNull();
    expect(!("modified" in result!) || result!.modified !== false).toBe(true);

    const modifiedResult = result as {
      meta?: { headers?: Record<string, string> };
      body?: ReadableStream<Uint8Array>;
    };

    const parsedBody = JSON.parse((await readStreamToBuffer(modifiedResult.body!)).toString("utf-8"));

    expect(parsedBody.instructions).toBe(originalBody.instructions);
    expect(parsedBody.input).toBe(originalBody.input);
    expect(parsedBody.max_output_tokens).toBe(originalBody.max_output_tokens);
    expect(parsedBody.stream).toBe(true);
    expect(parsedBody.store).toBe(false);
    expect(modifiedResult.meta?.headers?.conversation_id).toBeDefined();
  });
});

describe("createDroidPlugin.compaction aggregation", () => {
  it("aggregates compaction SSE into a non-stream JSON response", async () => {
    const plugin = createDroidPlugin();
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_test","object":"response","created_at":1234567890,"status":"in_progress","model":"gpt-5.4","output":[]}}',
      "",
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"<summary>Hello"}',
      "",
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":" world</summary>"}',
      "",
    ].join("\n");

    const result = await plugin.onResponse!({
      meta: {
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
      },
      body: streamFromBuffer(Buffer.from(sse, "utf-8")),
      store: createMockStore({
        activated: true as const,
        requestBodyLength: 900_000,
        requestKind: "compaction" as const,
      }),
    });

    expect(result).not.toBeNull();
    expect(!("modified" in result!) || result!.modified !== false).toBe(true);

    const modifiedResult = result as {
      meta?: { statusCode?: number; headers?: Record<string, string> };
      body?: ReadableStream<Uint8Array>;
    };

    expect(modifiedResult.meta?.statusCode).toBe(200);
    expect(modifiedResult.meta?.headers?.["content-type"]).toContain("application/json");

    const parsedBody = JSON.parse((await readStreamToBuffer(modifiedResult.body!)).toString("utf-8"));
    expect(parsedBody.status).toBe("completed");
    expect(parsedBody.output[0].content[0].text).toBe("<summary>Hello world</summary>");
  });

  it("rewrites compaction SSE failures into JSON errors", async () => {
    const plugin = createDroidPlugin();
    const sse = [
      "event: response.failed",
      'data: {"type":"response.failed","response":{"id":"resp_test","status":"failed","error":{"code":"server_error","message":"Upstream request failed"}}}',
      "",
    ].join("\n");

    const result = await plugin.onResponse!({
      meta: {
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
      },
      body: streamFromBuffer(Buffer.from(sse, "utf-8")),
      store: createMockStore({
        activated: true as const,
        requestBodyLength: 900_000,
        requestKind: "compaction" as const,
      }),
    });

    expect(result).not.toBeNull();
    expect(!("modified" in result!) || result!.modified !== false).toBe(true);

    const modifiedResult = result as {
      meta?: { statusCode?: number; headers?: Record<string, string> };
      body?: ReadableStream<Uint8Array>;
    };

    expect(modifiedResult.meta?.statusCode).toBe(400);
    expect(modifiedResult.meta?.headers?.["content-type"]).toContain("application/json");

    const parsedBody = JSON.parse((await readStreamToBuffer(modifiedResult.body!)).toString("utf-8"));
    expect(parsedBody.error.code).toBe("context_length_exceeded");
  });
});
