import { describe, it, expect, beforeEach } from "bun:test";
import { SessionManager } from "../session-manager";
import {
  sampleHeaders,
  sampleHeadersWithSessionId,
  sampleRequestBody,
  sampleRequestBodyMinimal,
  sampleRequestBodyWithStringSystem,
  createLargeRequestBody,
} from "./fixtures";
import type { AnthropicRequestBody } from "../types";

// Test URLs
const PROXY_URL = "http://localhost:20002/anthropic";
const TARGET_URL = "https://api.anthropic.com/v1/messages";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  describe("getSessionIdFromHeader", () => {
    it("should return session id from x-session-id header", () => {
      const sessionId = manager.getSessionIdFromHeader(sampleHeadersWithSessionId);
      expect(sessionId).toBe("test-session-abc123");
    });

    it("should return null when x-session-id is missing", () => {
      const sessionId = manager.getSessionIdFromHeader(sampleHeaders);
      expect(sessionId).toBeNull();
    });
  });

  describe("computeFinalSessionId (blockchain-style hash)", () => {
    it("should return null when no cache_control in messages", () => {
      const sessionId = manager.computeFinalSessionId(sampleRequestBodyMinimal);
      expect(sessionId).toBeNull();
    });

    it("should compute hash when cache_control exists", () => {
      const sessionId = manager.computeFinalSessionId(sampleRequestBody);
      expect(sessionId).toHaveLength(16);
      expect(typeof sessionId).toBe("string");
    });

    it("should return consistent hash for same context", () => {
      const id1 = manager.computeFinalSessionId(sampleRequestBody);
      const id2 = manager.computeFinalSessionId(sampleRequestBody);
      expect(id1).toBe(id2);
    });

    it("should return different hash for different system", () => {
      const id1 = manager.computeFinalSessionId(sampleRequestBody);
      const id2 = manager.computeFinalSessionId({
        ...sampleRequestBody,
        system: "Different system prompt",
      });
      expect(id1).not.toBe(id2);
    });

    it("should return different hash for different model", () => {
      const id1 = manager.computeFinalSessionId(sampleRequestBody);
      const id2 = manager.computeFinalSessionId({
        ...sampleRequestBody,
        model: "claude-3-sonnet-20240229",
      });
      expect(id1).not.toBe(id2);
    });

    it("should accumulate hash across messages (blockchain-style)", () => {
      // 创建带 cache_control 的消息
      const bodyWith2Msgs: AnthropicRequestBody = {
        model: "claude-opus-4-5-20251101",
        system: "test",
        messages: [
          { role: "user", content: [{ type: "text", text: "msg1", cache_control: { type: "ephemeral" } }] },
          { role: "assistant", content: "reply1" },
        ],
      };

      const bodyWith3Msgs: AnthropicRequestBody = {
        model: "claude-opus-4-5-20251101",
        system: "test",
        messages: [
          { role: "user", content: [{ type: "text", text: "msg1", cache_control: { type: "ephemeral" } }] },
          { role: "assistant", content: "reply1" },
          { role: "user", content: [{ type: "text", text: "msg2", cache_control: { type: "ephemeral" } }] },
        ],
      };

      const id1 = manager.computeFinalSessionId(bodyWith2Msgs);
      const id2 = manager.computeFinalSessionId(bodyWith3Msgs);

      // 因为消息数量不同，累积的 hash 也不同
      expect(id1).not.toBe(id2);
    });
  });

  describe("clearPrefixSessions", () => {
    it("should clear matching prefix sessions", () => {
      // 创建一个 session
      const body1: AnthropicRequestBody = {
        model: "claude-opus-4-5-20251101",
        system: "test",
        messages: [
          { role: "user", content: [{ type: "text", text: "msg1", cache_control: { type: "ephemeral" } }] },
        ],
      };
      const sessionId1 = manager.computeFinalSessionId(body1);
      expect(sessionId1).not.toBeNull();
      manager.touch(sessionId1!, body1, PROXY_URL, TARGET_URL, sampleHeaders);
      expect(manager.size).toBe(1);

      // 新请求包含更多消息，应该清理掉旧的 session
      const body2: AnthropicRequestBody = {
        model: "claude-opus-4-5-20251101",
        system: "test",
        messages: [
          { role: "user", content: [{ type: "text", text: "msg1", cache_control: { type: "ephemeral" } }] },
          { role: "assistant", content: "reply1" },
          { role: "user", content: [{ type: "text", text: "msg2", cache_control: { type: "ephemeral" } }] },
        ],
      };

      const cleared = manager.clearPrefixSessions(body2);
      expect(cleared).toContain(sessionId1!);
      expect(manager.size).toBe(0);
    });

    it("should return empty array when no sessions to clear", () => {
      const cleared = manager.clearPrefixSessions(sampleRequestBody);
      expect(cleared).toEqual([]);
    });
  });

  describe("touch", () => {
    it("should create new session state", () => {
      const state = manager.touch(
        "session-1",
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL,
        sampleHeaders
      );

      expect(state.sessionId).toBe("session-1");
      expect(state.pingCount).toBe(0);
      expect(state.lastActiveTime).toBeGreaterThan(0);
      expect(state.latestContextPayload).toEqual(sampleRequestBody);
      expect(state.proxyUrl).toBe(PROXY_URL);
      expect(state.targetUrl).toBe(TARGET_URL);
    });

    it("should reset pingCount on touch", () => {
      manager.touch(
        "session-1",
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL,
        sampleHeaders
      );

      const session = manager.get("session-1");
      if (session) {
        session.pingCount = 5;
        manager.set("session-1", session);
      }

      const updated = manager.touch(
        "session-1",
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL,
        sampleHeaders
      );

      expect(updated.pingCount).toBe(0);
    });

    it("should extract necessary headers for ping", () => {
      const state = manager.touch(
        "session-1",
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL,
        sampleHeaders
      );

      expect(state.headers["authorization"]).toBe("Bearer sk-ant-test-key-12345");
      expect(state.headers["x-api-key"]).toBe("sk-ant-test-key-12345");
      expect(state.headers["anthropic-version"]).toBe("2023-06-01");
      expect(state.headers["content-type"]).toBe("application/json");
      // Should not include unnecessary headers
      expect(state.headers["user-agent"]).toBeUndefined();
      expect(state.headers["host"]).toBeUndefined();
    });
  });

  describe("get/set/delete", () => {
    it("should store and retrieve session", () => {
      const state = manager.touch(
        "session-1",
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL,
        sampleHeaders
      );

      const retrieved = manager.get("session-1");
      expect(retrieved).toEqual(state);
    });

    it("should return undefined for non-existent session", () => {
      const session = manager.get("non-existent");
      expect(session).toBeUndefined();
    });

    it("should delete session", () => {
      manager.touch(
        "session-1",
        sampleRequestBody,
        PROXY_URL,
        TARGET_URL,
        sampleHeaders
      );

      const deleted = manager.delete("session-1");
      expect(deleted).toBe(true);
      expect(manager.get("session-1")).toBeUndefined();
    });

    it("should return false when deleting non-existent session", () => {
      const deleted = manager.delete("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("size and entries", () => {
    it("should track session count", () => {
      expect(manager.size).toBe(0);

      manager.touch("s1", sampleRequestBody, PROXY_URL, TARGET_URL, sampleHeaders);
      expect(manager.size).toBe(1);

      manager.touch("s2", sampleRequestBody, PROXY_URL, TARGET_URL, sampleHeaders);
      expect(manager.size).toBe(2);

      manager.delete("s1");
      expect(manager.size).toBe(1);
    });

    it("should iterate over all sessions", () => {
      manager.touch("s1", sampleRequestBody, PROXY_URL, TARGET_URL, sampleHeaders);
      manager.touch("s2", sampleRequestBodyMinimal, PROXY_URL, TARGET_URL, sampleHeaders);

      const entries = Array.from(manager.entries());
      expect(entries).toHaveLength(2);

      const ids = entries.map(([id]) => id);
      expect(ids).toContain("s1");
      expect(ids).toContain("s2");
    });
  });
});
