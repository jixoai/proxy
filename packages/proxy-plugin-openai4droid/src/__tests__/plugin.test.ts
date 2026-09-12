import { describe, expect, it } from "bun:test";
import { createDroidPlugin } from "../plugin";
import { rewriteRequest } from "../rewriter";
import { createMockStore, readStreamToBuffer, streamFromBuffer } from "@jixo/proxy-plugin";

function expectCodexTuiHeaders(headers: Record<string, string> | undefined): void {
  expect(headers).toBeDefined();

  const sessionId = headers!["session_id"];
  expect(sessionId).toBeDefined();
  expect(headers!["accept"]).toBe("text/event-stream");
  expect(headers!["user-agent"]).toBe(
    "codex-tui/0.125.0 (Mac OS 15.6.1; arm64) Apple_Terminal/455.1 (codex-tui; 0.125.0)",
  );
  expect(headers!["originator"]).toBe("codex-tui");
  expect(headers!["conversation_id"]).toBeUndefined();
  expect(headers!["x-client-request-id"]).toBe(sessionId);
  expect(headers!["x-codex-window-id"]).toBe(`${sessionId}:0`);

  for (const headerName of [
    "accept-encoding",
    "x-stainless-arch",
    "x-stainless-lang",
    "x-stainless-os",
    "x-stainless-package-version",
    "x-stainless-retry-count",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
  ]) {
    expect(headers![headerName]).toBeUndefined();
  }

  const turnMetadata = JSON.parse(headers!["x-codex-turn-metadata"]!);
  expect(turnMetadata).toMatchObject({
    session_id: sessionId,
    thread_source: "user",
    sandbox: "none",
  });
  expect(turnMetadata.turn_id).toEqual(expect.any(String));
  expect(turnMetadata.turn_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  expect(turnMetadata.turn_id).not.toBe(sessionId);
}

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
  it("does not short-circuit large standard Droid requests by default", async () => {
    const plugin = createDroidPlugin();
    const originalBody = {
      model: "gpt-5.4",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. Focus on the requested coding task.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "A".repeat(700 * 1024),
            },
          ],
        },
      ],
      stream: true,
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
    expect(result && "respondWith" in result).toBe(false);

    const modifiedResult = result as {
      meta?: { headers?: Record<string, string> };
      body?: ReadableStream<Uint8Array>;
    };

    const parsedBody = JSON.parse((await readStreamToBuffer(modifiedResult.body!)).toString("utf-8"));
    expect(parsedBody.input[0].content[0].text).toStartWith(
      `IMPORTANT:<system>${originalBody.instructions}</system>`,
    );
    expectCodexTuiHeaders(modifiedResult.meta?.headers);
  });

  it("short-circuits oversized standard Droid requests as context_length_exceeded", async () => {
    const plugin = createDroidPlugin({ preemptiveContextLengthThreshold: 1024 });
    const originalBody = {
      model: "gpt-5.4",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. Focus on the requested coding task.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "A".repeat(3000),
            },
          ],
        },
      ],
      stream: true,
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
    expect(result && "respondWith" in result).toBe(true);

    const shortCircuited = result as {
      respondWith: {
        statusCode: number;
        headers?: Record<string, string>;
        body?: Buffer;
      };
    };

    expect(shortCircuited.respondWith.statusCode).toBe(400);
    expect(shortCircuited.respondWith.headers?.["content-type"]).toContain("application/json");

    const parsedBody = JSON.parse(shortCircuited.respondWith.body!.toString("utf-8"));
    expect(parsedBody.error.code).toBe("context_length_exceeded");
  });

  it("rewrites standard Droid requests with Codex TUI headers", async () => {
    const plugin = createDroidPlugin();
    const originalBody = {
      model: "gpt-5.4",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. Focus on the requested coding task.",
      input: "Print hello.",
      stream: true,
    };

    const result = await plugin.onRequest!({
      meta: {
        method: "POST",
        url: "http://example.com/openai-droid/responses",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "accept-encoding": "gzip, deflate, br, zstd",
          "conversation_id": "legacy-conversation-id",
          "x-stainless-arch": "arm64",
          "x-stainless-lang": "js",
          "x-stainless-os": "MacOS",
          "x-stainless-package-version": "0.125.0",
          "x-stainless-retry-count": "0",
          "x-stainless-runtime": "node",
          "x-stainless-runtime-version": "v24.3.0",
        },
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

    expect(parsedBody.input).toBe(
      `IMPORTANT:<system>${originalBody.instructions}</system>

${originalBody.input}`,
    );
    expect(parsedBody.stream).toBe(true);
    expectCodexTuiHeaders(modifiedResult.meta?.headers);
  });

  it("strips unsupported body fields and normalizes message input items", async () => {
    const plugin = createDroidPlugin();
    const originalBody = {
      model: "gpt-5.4",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. Focus on the requested coding task.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Print hello.",
            },
          ],
        },
      ],
      reasoning: {
        effort: "medium",
        summary: "detailed",
      },
      prompt_cache_retention: {
        type: "ephemeral",
      },
      safety_identifier: "user-123",
      stream: true,
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

    expect(parsedBody.prompt_cache_retention).toBeUndefined();
    expect(parsedBody.safety_identifier).toBeUndefined();
    expect(parsedBody.reasoning).toEqual({ effort: "medium" });
    expect(parsedBody.input[0].type).toBe("message");
    expect(parsedBody.input[0].content[0].text).toBe(
      `IMPORTANT:<system>${originalBody.instructions}</system>

Print hello.`,
    );
    expectCodexTuiHeaders(modifiedResult.meta?.headers);
  });

  it("preserves native summarizer requests while only enabling upstream streaming", async () => {
    const plugin = createDroidPlugin({ preemptiveContextLengthThreshold: 1 });
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
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "j1/JS 6.25.0",
        },
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
    expect(modifiedResult.meta?.headers?.accept).toBe("application/json");
    expect(modifiedResult.meta?.headers?.["user-agent"]).toBe("j1/JS 6.25.0");
    expect(modifiedResult.meta?.headers?.originator).toBeUndefined();
    expect(modifiedResult.meta?.headers?.session_id).toBeUndefined();
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

  it("rewrites compaction SSE failures even when response.failed arrives after response.created", async () => {
    const plugin = createDroidPlugin();
    const sse = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_test","object":"response","created_at":1234567890,"status":"in_progress","model":"gpt-5.4","output":[]}}',
      "",
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

    const modifiedResult = result as {
      meta?: { statusCode?: number; headers?: Record<string, string> };
      body?: ReadableStream<Uint8Array>;
    };

    expect(modifiedResult.meta?.statusCode).toBe(200);
    expect(modifiedResult.meta?.headers?.["content-type"]).toContain("application/json");

    const parsedBody = JSON.parse((await readStreamToBuffer(modifiedResult.body!)).toString("utf-8"));
    expect(parsedBody.error.code).toBe("context_length_exceeded");
  });

  it("finalizes partial compaction summaries after the max wait budget", async () => {
    const plugin = createDroidPlugin({
      compactionHeartbeatMs: 1,
      compactionMaxWaitMs: 10,
      compactionMinPartialChars: 1,
    });
    const encoder = new TextEncoder();
    const stalledSse = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              "event: response.created",
              'data: {"type":"response.created","response":{"id":"resp_test","object":"response","created_at":1234567890,"status":"in_progress","model":"gpt-5.4","output":[]}}',
              "",
              "event: response.output_text.delta",
              'data: {"type":"response.output_text.delta","delta":"<summary>Hello"}',
              "",
            ].join("\n"),
          ),
        );
      },
      cancel() {
        return Promise.resolve();
      },
    });

    const result = await plugin.onResponse!({
      meta: {
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
      },
      body: stalledSse,
      store: createMockStore({
        activated: true as const,
        requestBodyLength: 900_000,
        requestKind: "compaction" as const,
      }),
    });

    expect(result).not.toBeNull();

    const modifiedResult = result as {
      meta?: { statusCode?: number; headers?: Record<string, string> };
      body?: ReadableStream<Uint8Array>;
    };

    expect(modifiedResult.meta?.statusCode).toBe(200);
    expect(modifiedResult.meta?.headers?.["content-type"]).toContain("application/json");

    const parsedBody = JSON.parse((await readStreamToBuffer(modifiedResult.body!)).toString("utf-8"));
    expect(parsedBody.output[0].content[0].text).toBe("<summary>Hello\n</summary>");
  });
});

describe("rewriteRequest", () => {
  it("preserves native compaction transport while enabling upstream streaming", () => {
    const originalBody = {
      model: "gpt-5.4",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. You excel at creating and maintaining summaries that capture the most salient details from technical conversations.",
      input: "Please summarize the following conversation:\\n```\\nUSER: hello\\n```",
      max_output_tokens: 4000,
      store: false,
    };

    const bodyText = JSON.stringify(originalBody);
    const result = rewriteRequest({
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "j1/JS 6.25.0",
      },
      body: bodyText,
    });

    expect(JSON.parse(result.body!)).toEqual({
      ...originalBody,
      stream: true,
    });
    expect(result.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "j1/JS 6.25.0",
    });
  });

  it("synthesizes deterministic ids for function_call / function_call_output items missing id (DeepSeek gateway compatibility)", () => {
    // DeepSeek 等网关严格校验 Responses schema，缺少 id 时返回 400
    // missing field `id` at messages[3]
    const originalBody = {
      model: "deepseek-v4-flash",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. Focus on the requested coding task.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        {
          type: "message",
          id: "msg_001",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
        {
          type: "function_call",
          call_id: "call_abc",
          name: "TodoWrite",
          arguments: "{\"todos\":\"test\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_abc",
          output: "TODO List Updated",
        },
        {
          type: "web_search_call",
          id: "ws_existing",
          status: "completed",
        },
      ],
      stream: true,
    };

    const result = rewriteRequest({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(originalBody),
    });

    const parsed = JSON.parse(result.body!);
    const items = parsed.input as Array<Record<string, unknown>>;

    // user message -> type message injected, no id needed
    expect(items[0]!.type).toBe("message");

    // existing assistant message -> preserved
    expect(items[1]!.id).toBe("msg_001");

    // function_call missing id -> derived from call_id (stable uuid)
    expect(items[2]!.type).toBe("function_call");
    expect(typeof items[2]!.id).toBe("string");
    expect(items[2]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-9[0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // function_call_output missing id -> derived from call_id (stable uuid)
    expect(items[3]!.type).toBe("function_call_output");
    expect(typeof items[3]!.id).toBe("string");
    expect(items[3]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-9[0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // web_search_call WITH id -> preserved verbatim
    expect(items[4]!.id).toBe("ws_existing");

    // 幂等：再次重写同一 body 应得到完全一致的 id
    const result2 = rewriteRequest({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(originalBody),
    });
    const parsed2 = JSON.parse(result2.body!);
    expect((parsed2.input as Array<Record<string, unknown>>)[2]!.id).toBe(items[2]!.id);
    expect((parsed2.input as Array<Record<string, unknown>>)[3]!.id).toBe(items[3]!.id);
  });

  it("keeps function_call items untouched when id already present", () => {
    const originalBody = {
      model: "gpt-5.4",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. Focus on the requested coding task.",
      input: [
        {
          type: "function_call",
          id: "fc_keep",
          call_id: "call_keep",
          name: "Read",
          arguments: "{}",
        },
      ],
      stream: true,
    };

    const result = rewriteRequest({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(originalBody),
    });

    const parsed = JSON.parse(result.body!);
    expect(parsed.input[0]!.id).toBe("fc_keep");
  });

  it("preserves input_image parts verbatim (vision is handled by image-vision plugin)", () => {
    // openai4droid 不再处理 image part；image-vision 插件会负责把图片转成文字描述。
    // 这里验证 image part 经过 openai4droid 后保持原样不变。
    const originalBody = {
      model: "deepseek-v4-flash",
      instructions:
        "You are Droid, an AI software engineering agent built by Factory. Focus on the requested coding task.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "look at this" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc",
              detail: "auto",
            },
          ],
        },
      ],
      stream: true,
    };

    const result = rewriteRequest({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(originalBody),
    });

    const parsed = JSON.parse(result.body!);
    const types = parsed.input[0].content.map((c: { type: string }) => c.type);
    expect(types).toEqual(["input_text", "input_image"]);
    expect(parsed.input[0].content[1].image_url).toBe("data:image/png;base64,abc");
  });
});

describe("createDroidPlugin.onResponse JSON-as-SSE error normalization", () => {
  it("rewrites upstream JSON error disguised as text/event-stream into a real SSE error event", async () => {
    // 复现 req 16606: content-type=text/event-stream 但 body 是裸 JSON
    // {"error":{"message":"Service temporarily overloaded",...}}
    // Droid 客户端的 SSE 解析器遇到这种情况会抛 "OpenAI response failed" 并中断整个会话。
    const plugin = createDroidPlugin();
    const jsonError = JSON.stringify({
      error: {
        message: "Service temporarily overloaded",
        type: "bad_response_status_code",
        param: "",
        code: "bad_response_status_code",
      },
    });

    const result = await plugin.onResponse!({
      meta: {
        statusCode: 529,
        headers: { "content-type": "text/event-stream" },
      },
      body: streamFromBuffer(Buffer.from(jsonError, "utf-8")),
      store: createMockStore({
        activated: true as const,
        requestBodyLength: 341_950,
        requestKind: "standard" as const,
      }),
    });

    expect(result).not.toBeNull();
    const modifiedResult = result as {
      meta?: { headers?: Record<string, string> };
      body?: ReadableStream<Uint8Array>;
    };
    expect(modifiedResult.meta?.headers?.["content-type"]).toContain("text/event-stream");

    const bodyText = (await readStreamToBuffer(modifiedResult.body!)).toString("utf-8");
    // 必须是合法 SSE：以 "event: error" 开头，data: 帧后面跟原 JSON
    expect(bodyText.startsWith("event: error\n")).toBe(true);
    expect(bodyText).toContain("data: ");
    // 原 message 应当保留，便于客户端展示
    expect(bodyText).toContain("Service temporarily overloaded");
  });

  it("passes through real SSE streams unchanged when first event is not error", async () => {
    const plugin = createDroidPlugin();
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_test","status":"in_progress"}}',
      "",
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"hello"}',
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
        requestBodyLength: 1_000,
        requestKind: "standard" as const,
      }),
    });

    // 不应改写为 error
    const modifiedResult = result as { body?: ReadableStream<Uint8Array> } | null;
    const bodyText = (await readStreamToBuffer(modifiedResult!.body!)).toString("utf-8");
    expect(bodyText).toContain("response.created");
    expect(bodyText).not.toStartWith("event: error");
  });
});
