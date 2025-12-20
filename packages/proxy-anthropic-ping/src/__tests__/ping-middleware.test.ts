import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { AnthropicPingMiddleware } from "../ping-middleware";
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
      maxPings: 3,
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
    it("should call onExpire when max pings exceeded", async () => {
      let expiredSessionId = "";
      let expireReason = "";

      const mw = new AnthropicPingMiddleware({
        maxPings: 1,
        idleThresholdMs: 10,
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

      // Manually set pingCount to max
      const session = mw.getSession("test-session-abc123");
      if (session) {
        session.pingCount = 1;
        session.lastActiveTime = Date.now() - 20;
      }

      // Wait for polling
      await new Promise((r) => setTimeout(r, 50));

      mw.destroy();

      expect(expiredSessionId).toBe("test-session-abc123");
      expect(expireReason).toBe("max_pings");
    });
  });

  describe("buildPingPayload (via integration)", () => {
    it("should create minimal ping payload structure", () => {
      // Test through the middleware's internal logic
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

describe("AnthropicPingMiddleware - Cancel Triggers", () => {
  it("should cancel request when header trigger matches", () => {
    let cancelCalled = false;

    const mw = new AnthropicPingMiddleware({
      cancelTriggers: [{ headerKey: "x-disable-ping" }],
      onCancel: () => {
        cancelCalled = true;
      },
    });

    // Request with cancel header - should not create session
    const result = mw.intercept(
      { ...sampleHeadersWithSessionId, "x-disable-ping": "true" },
      sampleRequestBody,
      PROXY_URL,
      TARGET_URL
    );

    expect(result.cancelled).toBe(true);
    expect(result.sessionId).toBeNull();
    expect(cancelCalled).toBe(true);

    mw.destroy();
  });

  it("should cancel request when message pattern matches", () => {
    const mw = new AnthropicPingMiddleware({
      cancelTriggers: [{ messagePattern: /^\/quit$/i }],
    });

    // Send /quit message - should not create session
    const result = mw.intercept(
      sampleHeadersWithSessionId,
      {
        ...sampleRequestBody,
        messages: [{ role: "user", content: "/quit" }],
      },
      PROXY_URL,
      TARGET_URL
    );

    expect(result.cancelled).toBe(true);
    expect(result.sessionId).toBeNull();
    expect(mw.getActiveSessionCount()).toBe(0);

    mw.destroy();
  });

  it("should cancel request when message pattern matches in TextBlock array", () => {
    const mw = new AnthropicPingMiddleware({
      cancelTriggers: [{ messagePattern: /goodbye|bye|exit/i }],
    });

    const result = mw.intercept(
      sampleHeadersWithSessionId,
      {
        ...sampleRequestBody,
        messages: [
          { role: "assistant", content: "How can I help?" },
          {
            role: "user",
            content: [
              { type: "text" as const, text: "Thanks for your help!" },
              { type: "text" as const, text: "Goodbye!" },
            ],
          },
        ],
      },
      PROXY_URL,
      TARGET_URL
    );

    expect(result.cancelled).toBe(true);
    expect(mw.getActiveSessionCount()).toBe(0);

    mw.destroy();
  });

  it("should cancel request with custom trigger", () => {
    const mw = new AnthropicPingMiddleware({
      cancelTriggers: [
        {
          custom: (body, headers) => {
            return body.max_tokens === 1 && headers["x-test"] === "cancel";
          },
        },
      ],
    });

    const result = mw.intercept(
      { ...sampleHeadersWithSessionId, "x-test": "cancel" },
      { ...sampleRequestBody, max_tokens: 1 },
      PROXY_URL,
      TARGET_URL
    );

    expect(result.cancelled).toBe(true);
    expect(mw.getActiveSessionCount()).toBe(0);

    mw.destroy();
  });

  it("should not cancel when no trigger matches", () => {
    const mw = new AnthropicPingMiddleware({
      cancelTriggers: [
        { headerKey: "x-disable-ping" },
        { messagePattern: /^\/quit$/i },
      ],
    });

    const result = mw.intercept(
      sampleHeadersWithSessionId,
      sampleRequestBody,
      PROXY_URL,
      TARGET_URL
    );

    expect(result.cancelled).toBe(false);
    expect(mw.getActiveSessionCount()).toBe(1);

    mw.destroy();
  });

  it("should clear prefix sessions even when cancelled", () => {
    const mw = new AnthropicPingMiddleware({
      cancelTriggers: [{ messagePattern: /^\/quit$/i }],
    });

    // First create a session (don't use header session ID, use hash-based)
    mw.intercept(sampleHeaders, sampleRequestBody, PROXY_URL, TARGET_URL);
    expect(mw.getActiveSessionCount()).toBe(1);

    // Now send more messages with /quit - should clear prefix sessions
    // The new request includes original messages as prefix, so old session should be cleared
    const result = mw.intercept(
      sampleHeaders,
      {
        ...sampleRequestBody,
        messages: [
          ...sampleRequestBody.messages!,
          { role: "assistant", content: "ok" },
          { role: "user", content: "/quit" },
        ],
      },
      PROXY_URL,
      TARGET_URL
    );

    expect(result.cancelled).toBe(true);
    expect(result.clearedCount).toBeGreaterThanOrEqual(1);
    expect(mw.getActiveSessionCount()).toBe(0);

    mw.destroy();
  });

  it("should support multiple triggers (OR logic)", () => {
    const mw = new AnthropicPingMiddleware({
      cancelTriggers: [
        { headerKey: "x-no-cache" },
        { messagePattern: /^\/end$/i },
        { messagePattern: /^bye$/i },
      ],
    });

    // Test first trigger
    let result = mw.intercept(
      { ...sampleHeaders, "x-session-id": "s1", "x-no-cache": "1" },
      sampleRequestBody,
      PROXY_URL,
      TARGET_URL
    );
    expect(result.cancelled).toBe(true);

    // Test second trigger
    result = mw.intercept(
      { ...sampleHeaders, "x-session-id": "s2" },
      { ...sampleRequestBody, messages: [{ role: "user", content: "/end" }] },
      PROXY_URL,
      TARGET_URL
    );
    expect(result.cancelled).toBe(true);

    // Test third trigger
    result = mw.intercept(
      { ...sampleHeaders, "x-session-id": "s3" },
      { ...sampleRequestBody, messages: [{ role: "user", content: "bye" }] },
      PROXY_URL,
      TARGET_URL
    );
    expect(result.cancelled).toBe(true);

    expect(mw.getActiveSessionCount()).toBe(0);

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

    // Verify system has cache_control blocks
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
