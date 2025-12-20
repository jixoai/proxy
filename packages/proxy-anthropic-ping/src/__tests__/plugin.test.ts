import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createAnthropicPingPlugin } from "../plugin";
import type { RequestHookParams } from "@jixo/proxy-plugin";
import {
  sampleHeaders,
  sampleHeadersWithSessionId,
  sampleRequestBody,
  sampleRequestBodyMinimal,
} from "./fixtures";

describe("createAnthropicPingPlugin", () => {
  let plugin: ReturnType<typeof createAnthropicPingPlugin>;

  beforeEach(() => {
    plugin = createAnthropicPingPlugin({
      maxPings: 5,
      debug: false,
    });
  });

  afterEach(() => {
    plugin.middleware.destroy();
  });

  describe("plugin properties", () => {
    it("should have correct name", () => {
      expect(plugin.name).toBe("anthropic-ping");
    });

    it("should expose middleware instance", () => {
      expect(plugin.middleware).toBeDefined();
      expect(typeof plugin.middleware.intercept).toBe("function");
    });

    it("should have onRequest handler", () => {
      expect(plugin.onRequest).toBeDefined();
      expect(typeof plugin.onRequest).toBe("function");
    });
  });

  describe("onRequest", () => {
    it("should intercept Anthropic messages request", async () => {
      const params: RequestHookParams = {
        meta: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: sampleHeadersWithSessionId,
        },
        body: Buffer.from(JSON.stringify(sampleRequestBody)),
      };

      const result = await plugin.onRequest!(params);

      // Should return modified: false (processed but not modified)
      expect(result).not.toBeNull();
      expect("modified" in result! && result.modified === false).toBe(true);

      // Should have tracked the session
      expect(plugin.middleware.getActiveSessionCount()).toBe(1);
      expect(plugin.middleware.getSession("test-session-abc123")).toBeDefined();
    });

    it("should intercept requests with /anthropic/ in URL", async () => {
      const params: RequestHookParams = {
        meta: {
          method: "POST",
          url: "http://localhost:20002/anthropic/v1/messages",
          headers: { ...sampleHeaders, "x-session-id": "local-session" },
        },
        body: Buffer.from(JSON.stringify(sampleRequestBody)),
      };

      await plugin.onRequest!(params);

      expect(plugin.middleware.getActiveSessionCount()).toBe(1);
      expect(plugin.middleware.getSession("local-session")).toBeDefined();
    });

    it("should ignore non-messages requests", async () => {
      const params: RequestHookParams = {
        meta: {
          method: "GET",
          url: "https://api.anthropic.com/v1/models",
          headers: sampleHeaders,
        },
        body: Buffer.alloc(0),
      };

      const result = await plugin.onRequest!(params);

      expect(result).toBeNull();
      expect(plugin.middleware.getActiveSessionCount()).toBe(0);
    });

    it("should ignore requests without messages", async () => {
      const params: RequestHookParams = {
        meta: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: sampleHeaders,
        },
        body: Buffer.from(JSON.stringify({ model: "claude-3" })),
      };

      const result = await plugin.onRequest!(params);

      expect(result).toBeNull();
      expect(plugin.middleware.getActiveSessionCount()).toBe(0);
    });

    it("should ignore requests with empty messages", async () => {
      const params: RequestHookParams = {
        meta: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: sampleHeaders,
        },
        body: Buffer.from(JSON.stringify({ model: "claude-3", messages: [] })),
      };

      const result = await plugin.onRequest!(params);

      expect(result).toBeNull();
      expect(plugin.middleware.getActiveSessionCount()).toBe(0);
    });

    it("should handle invalid JSON body", async () => {
      const params: RequestHookParams = {
        meta: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: sampleHeaders,
        },
        body: Buffer.from("not valid json"),
      };

      const result = await plugin.onRequest!(params);

      expect(result).toBeNull();
      expect(plugin.middleware.getActiveSessionCount()).toBe(0);
    });

    it("should track multiple sessions", async () => {
      const params1: RequestHookParams = {
        meta: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: { ...sampleHeaders, "x-session-id": "session-1" },
        },
        body: Buffer.from(JSON.stringify(sampleRequestBody)),
      };

      const params2: RequestHookParams = {
        meta: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: { ...sampleHeaders, "x-session-id": "session-2" },
        },
        body: Buffer.from(JSON.stringify(sampleRequestBodyMinimal)),
      };

      await plugin.onRequest!(params1);
      await plugin.onRequest!(params2);

      expect(plugin.middleware.getActiveSessionCount()).toBe(2);
    });
  });

  describe("enabled option", () => {
    it("should not track when disabled", async () => {
      const disabledPlugin = createAnthropicPingPlugin({ enabled: false });

      const params: RequestHookParams = {
        meta: {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: sampleHeadersWithSessionId,
        },
        body: Buffer.from(JSON.stringify(sampleRequestBody)),
      };

      const result = await disabledPlugin.onRequest!(params);

      expect(result).toBeNull();
      expect(disabledPlugin.middleware.getActiveSessionCount()).toBe(0);

      disabledPlugin.middleware.destroy();
    });
  });
});

describe("Plugin Integration", () => {
  it("should work with real-world request structure", async () => {
    const plugin = createAnthropicPingPlugin({
      debug: false,
      onPing: (sessionId, count) => {
        console.log(`Ping: ${sessionId} count=${count}`);
      },
    });

    // Simulate real request from database sample
    const realWorldBody = {
      model: "claude-opus-4-5-20251101",
      max_tokens: 32000,
      stream: true,
      system: [
        {
          type: "text",
          text: "You are Droid, an AI software engineering agent built by Factory.",
        },
        {
          type: "text",
          text: "You work within an interactive cli tool...",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>\nUser system info (darwin 25.1.0)\n</system-reminder>",
            },
            {
              type: "text",
              text: "Hello",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'll help you with that." }],
        },
        {
          role: "user",
          content: "Please analyze the code.",
        },
      ],
    };

    const params: RequestHookParams = {
      meta: {
        method: "POST",
        url: "http://localhost:20003/droid/v1/messages",
        headers: {
          host: "localhost:20003",
          "user-agent": "factory-cli/0.36.5",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": "sk-ant-test",
        },
      },
      body: Buffer.from(JSON.stringify(realWorldBody)),
    };

    await plugin.onRequest!(params);

    expect(plugin.middleware.getActiveSessionCount()).toBe(1);

    // Get session and verify stored data via public API
    // The middleware uses hash-based session ID, so we check count instead
    const sessionManager = (plugin.middleware as any).sessionManager;
    expect(sessionManager.size).toBe(1);

    // Get the first session via entries iterator
    const iterator = sessionManager.entries();
    const first = iterator.next();
    expect(first.done).toBe(false);

    const [_sessionId, state] = first.value as [string, any];
    expect(state.latestContextPayload.model).toBe("claude-opus-4-5-20251101");
    expect(state.headers["x-api-key"]).toBe("sk-ant-test");
    expect(state.headers["anthropic-version"]).toBe("2023-06-01");

    plugin.middleware.destroy();
  });
});
