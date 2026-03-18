import { describe, expect, test } from "bun:test";
import { readStreamToBuffer, streamFromBuffer } from "@jixo/proxy-plugin";
import { createModelRewritePlugin, rewritePayloadModel } from "../plugin";

describe("model rewrite plugin", () => {
  test("skips precheck when model config is missing", () => {
    const plugin = createModelRewritePlugin();

    expect(
      plugin.shouldProcessRequest?.({
        method: "POST",
        url: "https://api.example.com/v1/chat/completions",
        headers: { "content-type": "application/json" },
      }),
    ).toBe(false);
  });

  test("rewrites top-level model with string config", async () => {
    const plugin = createModelRewritePlugin({ model: "gpt-5.4" });
    const result = await plugin.onRequest?.({
      meta: {
        method: "POST",
        url: "https://api.example.com/v1/chat/completions",
        headers: { "content-type": "application/json" },
      },
      body: streamFromBuffer(
        Buffer.from(JSON.stringify({ model: "gpt-4o-mini", messages: [] }), "utf-8"),
      ),
    });

    expect(result).toBeTruthy();
    const rewrittenBody = (result as { body?: ReadableStream<Uint8Array> }).body;
    if (!rewrittenBody) {
      throw new Error("expected rewritten body");
    }

    const parsed = JSON.parse((await readStreamToBuffer(rewrittenBody)).toString("utf-8"));
    expect(parsed.model).toBe("gpt-5.4");
  });

  test("rewrites top-level model with exact mapping", () => {
    const result = rewritePayloadModel(
      { model: "gpt-4o-mini", input: [] },
      { "gpt-4o-mini": "gpt-5.4" },
    );

    expect(result.modified).toBe(true);
    expect((result.payload as { model: string }).model).toBe("gpt-5.4");
  });

  test("rewrites top-level model with regex mapping", () => {
    const result = rewritePayloadModel(
      { model: "claude-sonnet-4-5", messages: [] },
      { "/^claude-/": "gpt-" },
    );

    expect(result.modified).toBe(true);
    expect((result.payload as { model: string }).model).toBe("gpt-sonnet-4-5");
  });

  test("uses wildcard mapping as fallback", () => {
    const result = rewritePayloadModel(
      { model: "unknown-model", messages: [] },
      { "*": "gpt-5.4-mini" },
    );

    expect(result.modified).toBe(true);
    expect((result.payload as { model: string }).model).toBe("gpt-5.4-mini");
  });

  test("rewrites response.create envelope model", () => {
    const result = rewritePayloadModel(
      {
        type: "response.create",
        response: {
          model: "gpt-4.1",
          input: [],
        },
      },
      "gpt-5.4",
    );

    expect(result.modified).toBe(true);
    expect(
      (result.payload as { response: { model: string } }).response.model,
    ).toBe("gpt-5.4");
    expect(result.targetPath).toBe("response.model");
  });

  test("returns unmodified payload when mapping does not match", () => {
    const result = rewritePayloadModel(
      { model: "gpt-4.1", input: [] },
      { "gpt-4o-mini": "gpt-5.4" },
    );

    expect(result.modified).toBe(false);
    expect((result.payload as { model: string }).model).toBe("gpt-4.1");
  });
});
