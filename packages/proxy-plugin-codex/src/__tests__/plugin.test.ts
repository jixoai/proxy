import { describe, expect, test } from "bun:test";
import { readStreamToBuffer, streamFromBuffer } from "@jixo/proxy-plugin";
import { createCodexPlugin } from "../plugin";

describe("codex plugin", () => {
  test("only prechecks JSON requests on /responses", () => {
    const plugin = createCodexPlugin();

    expect(
      plugin.shouldProcessRequest?.({
        method: "POST",
        url: "https://api.example.com/v1/responses",
        headers: { "content-type": "application/json" },
      }),
    ).toBe(true);

    expect(
      plugin.shouldProcessRequest?.({
        method: "POST",
        url: "https://api.example.com/v1/chat/completions",
        headers: { "content-type": "application/json" },
      }),
    ).toBe(false);

    expect(
      plugin.shouldProcessRequest?.({
        method: "POST",
        url: "https://api.example.com/v1/responses",
        headers: { "content-type": "text/plain" },
      }),
    ).toBe(false);
  });

  test("removes top-level prompt_cache_key and include", async () => {
    const plugin = createCodexPlugin();
    const requestBody = {
      model: "gpt-5",
      prompt_cache_key: "thread_123",
      include: ["reasoning.encrypted_content"],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    };

    const result = await plugin.onRequest?.({
      meta: {
        method: "POST",
        url: "https://api.example.com/v1/responses",
        headers: { "content-type": "application/json" },
      },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    expect(result).toBeTruthy();
    const rewritten = result as Exclude<typeof result, null>;
    const rewrittenBody = (rewritten as any).body as ReadableStream<Uint8Array> | undefined;
    if (!rewrittenBody) {
      throw new Error("expected rewritten body");
    }

    const bodyBuffer = await readStreamToBuffer(rewrittenBody);
    const parsed = JSON.parse(bodyBuffer.toString("utf-8"));

    expect(parsed.prompt_cache_key).toBeUndefined();
    expect(parsed.include).toBeUndefined();
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.input).toEqual(requestBody.input);
  });

  test("removes prompt_cache_key and include from response.create envelope", async () => {
    const plugin = createCodexPlugin();
    const requestBody = {
      type: "response.create",
      response: {
        model: "gpt-5",
        prompt_cache_key: "thread_123",
        include: ["reasoning.encrypted_content"],
        input: [],
      },
    };

    const result = await plugin.onRequest?.({
      meta: {
        method: "POST",
        url: "https://api.example.com/v1/responses",
        headers: { "content-type": "application/json" },
      },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    expect(result).toBeTruthy();
    const rewritten = result as Exclude<typeof result, null>;
    const rewrittenBody = (rewritten as any).body as ReadableStream<Uint8Array> | undefined;
    if (!rewrittenBody) {
      throw new Error("expected rewritten body");
    }

    const bodyBuffer = await readStreamToBuffer(rewrittenBody);
    const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
    expect(parsed.response.prompt_cache_key).toBeUndefined();
    expect(parsed.response.include).toBeUndefined();
    expect(parsed.response.model).toBe("gpt-5");
  });

  test("returns null when prompt_cache_key/include are absent", async () => {
    const plugin = createCodexPlugin();

    const result = await plugin.onRequest?.({
      meta: {
        method: "POST",
        url: "https://api.example.com/v1/responses",
        headers: { "content-type": "application/json" },
      },
      body: streamFromBuffer(
        Buffer.from(
          JSON.stringify({
            model: "gpt-5",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
          }),
          "utf-8",
        ),
      ),
    });

    expect(result).toBeNull();
  });

  test("removes include when prompt_cache_key is absent", async () => {
    const plugin = createCodexPlugin();
    const result = await plugin.onRequest?.({
      meta: {
        method: "POST",
        url: "https://api.example.com/v1/responses",
        headers: { "content-type": "application/json" },
      },
      body: streamFromBuffer(
        Buffer.from(
          JSON.stringify({
            model: "gpt-5",
            include: ["reasoning.encrypted_content"],
            input: [],
          }),
          "utf-8",
        ),
      ),
    });

    expect(result).toBeTruthy();
    const rewritten = result as Exclude<typeof result, null>;
    const rewrittenBody = (rewritten as any).body as ReadableStream<Uint8Array> | undefined;
    if (!rewrittenBody) {
      throw new Error("expected rewritten body");
    }

    const bodyBuffer = await readStreamToBuffer(rewrittenBody);
    const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
    expect(parsed.include).toBeUndefined();
    expect(parsed.model).toBe("gpt-5");
  });
});
