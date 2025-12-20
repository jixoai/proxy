import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AnthropicPingMiddleware } from "../ping-middleware";
import { PING_SESSION_END_MESSAGE } from "../types";
import {
  sampleHeaders,
  sampleHeadersWithSessionId,
  sampleRequestBody,
  sampleRequestBodyWithStringSystem,
  sampleSystem,
} from "./fixtures";

// Test URLs
const PROXY_URL = "http://localhost:20002/anthropic";
const TARGET_URL = "https://api.anthropic.com/v1/messages";

describe("AnthropicPingMiddleware", () => {
  let middleware: AnthropicPingMiddleware;

  beforeEach(() => {
    middleware = new AnthropicPingMiddleware({
      maxKeepAliveDurationMs: 60 * 60 * 1000, // 60 minutes
      idleThresholdMs: 100,
      pollingIntervalMs: 50,
      debug: false,
    });
  });

  afterEach(() => {
    middleware.destroy();
  });

  describe("intercept", () => {
    it("should create new session on first request", () => {
      const result = middleware.intercept(
        sampleHeaders,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      expect(result.isNew).toBe(true);
      expect(result.sessionId).toHaveLength(16);
    });

    it("should use x-session-id when provided", () => {
      const result = middleware.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      expect(result.sessionId).toBe("test-session-abc123");
      expect(result.isNew).toBe(true);
    });

    it("should recognize existing session", () => {
      const first = middleware.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      const second = middleware.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      expect(first.sessionId).toBe(second.sessionId);
    });

    it("should reset pingCount on new request", () => {
      middleware.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      // Manually increment pingCount
      const session = middleware.getSession("test-session-abc123");
      expect(session).toBeDefined();
      session!.pingCount = 5;

      // New request should reset
      middleware.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      const updated = middleware.getSession("test-session-abc123");
      expect(updated?.pingCount).toBe(0);
    });

    it("should start polling after first intercept", async () => {
      expect(middleware.getActiveSessionCount()).toBe(0);

      middleware.intercept(
        sampleHeaders,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      expect(middleware.getActiveSessionCount()).toBe(1);
    });
  });

  describe("getSession / getActiveSessionCount", () => {
    it("should return session by id", () => {
      middleware.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      const session = middleware.getSession("test-session-abc123");
      expect(session).toBeDefined();
      expect(session?.latestContextPayload).toEqual(sampleRequestBody);
    });

    it("should return undefined for non-existent session", () => {
      const session = middleware.getSession("non-existent");
      expect(session).toBeUndefined();
    });

    it("should track active session count", () => {
      expect(middleware.getActiveSessionCount()).toBe(0);

      middleware.intercept(
        { ...sampleHeaders, "x-session-id": "s1" },
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );
      expect(middleware.getActiveSessionCount()).toBe(1);

      middleware.intercept(
        { ...sampleHeaders, "x-session-id": "s2" },
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );
      expect(middleware.getActiveSessionCount()).toBe(2);
    });
  });

  describe("destroySession", () => {
    it("should remove session", () => {
      middleware.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      expect(middleware.getActiveSessionCount()).toBe(1);

      const result = middleware.destroySession("test-session-abc123");
      expect(result).toBe(true);
      expect(middleware.getActiveSessionCount()).toBe(0);
    });

    it("should return false for non-existent session", () => {
      const result = middleware.destroySession("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("destroy", () => {
    it("should clear all sessions and stop polling", () => {
      middleware.intercept(
        { ...sampleHeaders, "x-session-id": "s1" },
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );
      middleware.intercept(
        { ...sampleHeaders, "x-session-id": "s2" },
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      expect(middleware.getActiveSessionCount()).toBe(2);

      middleware.destroy();

      expect(middleware.getActiveSessionCount()).toBe(0);
    });
  });

  describe("callbacks", () => {
    it("should call onExpire when session exceeds max duration", async () => {
      let expiredSessionId = "";
      let expireReason = "";

      const mw = new AnthropicPingMiddleware({
        maxKeepAliveDurationMs: 10, // Very short for testing
        idleThresholdMs: 5,
        pollingIntervalMs: 20,
        onExpire: (sessionId, reason) => {
          expiredSessionId = sessionId;
          expireReason = reason;
        },
      });

      mw.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      // Wait for session to expire
      await new Promise((r) => setTimeout(r, 50));

      mw.destroy();

      expect(expiredSessionId).toBe("test-session-abc123");
      expect(expireReason).toBe("timeout");
    });
  });

  describe("buildPingPayload (via integration)", () => {
    it("should create minimal ping payload structure", () => {
      const mw = new AnthropicPingMiddleware({ debug: false });

      mw.intercept(
        sampleHeadersWithSessionId,
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL
      );

      const session = mw.getSession("test-session-abc123");
      expect(session).toBeDefined();
      expect(session?.latestContextPayload.model).toBe("claude-opus-4-5-20251101");
      expect(session?.latestContextPayload.system).toEqual(sampleSystem);

      mw.destroy();
    });
  });
});

describe("AnthropicPingMiddleware - No cache_control", () => {
  it("should not create session when no cache_control in messages", () => {
    const mw = new AnthropicPingMiddleware({});

    const result = mw.intercept(
      sampleHeaders,
      {
        model: "claude-3-sonnet",
        messages: [{ role: "user", content: "hello" }],
      },
      PROXY_URL,
      TARGET_URL
    );

    expect(result.sessionId).toBeNull();
    expect(result.isNew).toBe(false);
    expect(mw.getActiveSessionCount()).toBe(0);

    mw.destroy();
  });
});

describe("AnthropicPingMiddleware - Prefix Session Clearing", () => {
  it("should clear old session when new request extends conversation", () => {
    const mw = new AnthropicPingMiddleware({});

    // First request creates a session
    mw.intercept(sampleHeaders, sampleRequestBody, PROXY_URL, TARGET_URL);
    expect(mw.getActiveSessionCount()).toBe(1);

    // Second request with more messages should clear the old session
    const result = mw.intercept(
      sampleHeaders,
      {
        ...sampleRequestBody,
        messages: [
          ...sampleRequestBody.messages!,
          { role: "assistant", content: "response" },
          {
            role: "user",
            content: [{ type: "text" as const, text: "next", cache_control: { type: "ephemeral" } }],
          },
        ],
      },
      PROXY_URL,
      TARGET_URL
    );

    expect(result.clearedCount).toBeGreaterThanOrEqual(1);
    // New session created with new hash
    expect(mw.getActiveSessionCount()).toBe(1);

    mw.destroy();
  });
});

describe("AnthropicPingMiddleware - End Message", () => {
  it("should return shouldReturn204 when end message is received", () => {
    const mw = new AnthropicPingMiddleware({});

    // First create a session
    mw.intercept(sampleHeaders, sampleRequestBody, PROXY_URL, TARGET_URL);
    expect(mw.getActiveSessionCount()).toBe(1);

    // Send end message
    const result = mw.intercept(
      sampleHeaders,
      {
        ...sampleRequestBody,
        messages: [
          ...sampleRequestBody.messages!,
          { role: "user", content: PING_SESSION_END_MESSAGE },
        ],
      },
      PROXY_URL,
      TARGET_URL
    );

    expect(result.shouldReturn204).toBe(true);
    expect(result.sessionId).toBeNull();
    expect(mw.getActiveSessionCount()).toBe(0);

    mw.destroy();
  });

  it("should call onExpire with 'manual' reason when end message clears sessions", () => {
    let expiredCount = 0;
    let lastReason = "";

    const mw = new AnthropicPingMiddleware({
      onExpire: (_sessionId, reason) => {
        expiredCount++;
        lastReason = reason;
      },
    });

    // Create a session
    mw.intercept(sampleHeaders, sampleRequestBody, PROXY_URL, TARGET_URL);

    // Send end message
    mw.intercept(
      sampleHeaders,
      {
        ...sampleRequestBody,
        messages: [
          ...sampleRequestBody.messages!,
          { role: "user", content: PING_SESSION_END_MESSAGE },
        ],
      },
      PROXY_URL,
      TARGET_URL
    );

    expect(expiredCount).toBeGreaterThanOrEqual(1);
    expect(lastReason).toBe("manual");

    mw.destroy();
  });

  it("should handle end message with TextBlock array", () => {
    const mw = new AnthropicPingMiddleware({});

    mw.intercept(sampleHeaders, sampleRequestBody, PROXY_URL, TARGET_URL);

    const result = mw.intercept(
      sampleHeaders,
      {
        ...sampleRequestBody,
        messages: [
          ...sampleRequestBody.messages!,
          {
            role: "user",
            content: [{ type: "text" as const, text: PING_SESSION_END_MESSAGE }],
          },
        ],
      },
      PROXY_URL,
      TARGET_URL
    );

    expect(result.shouldReturn204).toBe(true);

    mw.destroy();
  });

  it("should not treat regular messages as end message", () => {
    const mw = new AnthropicPingMiddleware({});

    const result = mw.intercept(
      sampleHeaders,
      sampleRequestBody,
      PROXY_URL,
      TARGET_URL
    );

    expect(result.shouldReturn204).toBe(false);
    expect(mw.getActiveSessionCount()).toBe(1);

    mw.destroy();
  });
});

describe("AnthropicPingMiddleware - Ping Payload", () => {
  it("should handle array system with cache_control", () => {
    const middleware = new AnthropicPingMiddleware({});

    middleware.intercept(
      sampleHeadersWithSessionId,
      sampleRequestBody,
      PROXY_URL,
      TARGET_URL
    );

    const session = middleware.getSession("test-session-abc123");
    expect(session?.latestContextPayload.system).toBeDefined();

    const system = session?.latestContextPayload.system;
    if (Array.isArray(system)) {
      const hasCacheControl = system.some((b) => b.cache_control);
      expect(hasCacheControl).toBe(true);
    }

    middleware.destroy();
  });

  it("should handle string system", () => {
    const middleware = new AnthropicPingMiddleware({});

    middleware.intercept(
      sampleHeadersWithSessionId,
      sampleRequestBodyWithStringSystem,
      PROXY_URL,
      TARGET_URL
    );

    const session = middleware.getSession("test-session-abc123");
    expect(session?.latestContextPayload.system).toBe("You are a helpful assistant.");

    middleware.destroy();
  });
});
