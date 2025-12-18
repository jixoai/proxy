import { describe, it, expect } from "bun:test";
import { createDroidPlugin } from "../plugin";
import type { RequestHookParams, ResponseHookParams } from "@jixo/proxy-plugin";

describe("createDroidPlugin", () => {
  it("should create a plugin with correct name", () => {
    const plugin = createDroidPlugin();
    expect(plugin.name).toBe("droid-plugin");
  });

  it("should have onRequest handler", () => {
    const plugin = createDroidPlugin();
    expect(plugin.onRequest).toBeDefined();
  });

  it("should have onResponse handler", () => {
    const plugin = createDroidPlugin();
    expect(plugin.onResponse).toBeDefined();
  });

  it("should rewrite Droid request", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      model: "claude-3-opus",
      system: "You are Droid, an AI assistant.",
      messages: [{ role: "user", content: "Hello" }],
    });

    const params: RequestHookParams = {
      meta: {
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-ant-123",
        },
      },
      body: Buffer.from(body),
    };

    const result = await plugin.onRequest!(params);

    expect(result).not.toBeNull();
    expect(result!.meta?.headers).toBeDefined();
    expect(result!.body).toBeDefined();

    const headers = result!.meta!.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toContain("claude-code");
    expect(headers["authorization"]).toBe("Bearer sk-ant-123");

    const parsedBody = JSON.parse(result!.body!.toString("utf-8"));
    expect(Array.isArray(parsedBody.system)).toBe(true);
    expect(parsedBody.system[0].text).toContain("Claude Code");
  });

  it("should return null for non-Droid request", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      system: "You are Claude.",
      messages: [],
    });

    const params: RequestHookParams = {
      meta: {
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
    };

    const result = await plugin.onRequest!(params);

    expect(result).toBeNull();
  });

  it("should rewrite upstream request failed error response", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      type: "error",
      error: {
        code: 400,
        type: "server_error",
        message: "Upstream request failed",
      },
    });

    const params: ResponseHookParams = {
      meta: {
        statusCode: 400,
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
    };

    const result = await plugin.onResponse!(params);

    expect(result).not.toBeNull();
    expect(result!.meta?.statusCode).toBe(400);

    const parsedBody = JSON.parse(result!.body!.toString("utf-8"));
    expect(parsedBody.error.code).toBe("context_length_exceeded");
    expect(parsedBody.error.type).toBe("invalid_request_error");
  });

  it("should return null for normal response", async () => {
    const plugin = createDroidPlugin();
    const body = JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "Hello!" }],
    });

    const params: ResponseHookParams = {
      meta: {
        statusCode: 200,
        headers: { "content-type": "application/json" },
      },
      body: Buffer.from(body),
    };

    const result = await plugin.onResponse!(params);

    expect(result).toBeNull();
  });
});
