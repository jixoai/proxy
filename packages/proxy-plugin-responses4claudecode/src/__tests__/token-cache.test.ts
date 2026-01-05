import { describe, expect, test, beforeEach } from "bun:test";
import {
  estimateTokenCount,
  createCountTokensResponse,
  cacheInputTokens,
  getCachedInputTokens,
  extractSessionId,
  extractUsageFromResponse,
  extractUsageFromSSE,
} from "../token-cache";

describe("token-cache", () => {
  describe("extractSessionId", () => {
    test("should extract session ID from user_id", () => {
      const metadata = {
        user_id: "user_xxx_account__session_5a68f501-e620-4ec6-858e-dba7a22bfe17",
      };
      expect(extractSessionId(metadata)).toBe("5a68f501-e620-4ec6-858e-dba7a22bfe17");
    });

    test("should return default for missing metadata", () => {
      expect(extractSessionId(undefined)).toBe("default");
      expect(extractSessionId({})).toBe("default");
    });
  });

  describe("cacheInputTokens and getCachedInputTokens", () => {
    beforeEach(() => {
      // 使用唯一的 session ID 避免测试间干扰
    });

    test("should cache and retrieve input tokens", () => {
      const sessionId = `test-session-${Date.now()}`;
      cacheInputTokens(sessionId, 12345, 10);

      const cached = getCachedInputTokens(sessionId);
      expect(cached).toBeDefined();
      expect(cached!.inputTokens).toBe(12345);
      expect(cached!.messageCount).toBe(10);
    });

    test("should return null for non-existent session", () => {
      const cached = getCachedInputTokens("non-existent-session");
      expect(cached).toBeNull();
    });
  });

  describe("estimateTokenCount", () => {
    test("should estimate tokens for simple text message", () => {
      const body = {
        messages: [
          { role: "user" as const, content: "Hello, how are you?" },
        ],
      };
      const tokens = estimateTokenCount(body);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(50);
    });

    test("should estimate tokens for Chinese text (higher ratio)", () => {
      const body = {
        messages: [
          { role: "user" as const, content: "你好，世界！" },
        ],
      };
      const tokens = estimateTokenCount(body);
      // 中文字符每个约 2.5 tokens
      expect(tokens).toBeGreaterThan(10);
    });

    test("should estimate tokens with system prompt", () => {
      const body = {
        system: "You are a helpful assistant.",
        messages: [
          { role: "user" as const, content: "Hi" },
        ],
      };
      const tokens = estimateTokenCount(body);
      expect(tokens).toBeGreaterThan(10);
    });

    test("should estimate tokens with tools", () => {
      const body = {
        messages: [{ role: "user" as const, content: "Hi" }],
        tools: [
          { name: "tool1", description: "A tool", input_schema: {} },
          { name: "tool2", description: "Another tool", input_schema: {} },
        ],
      };
      const tokens = estimateTokenCount(body);
      expect(tokens).toBeGreaterThan(20);
    });

    test("should handle empty body", () => {
      const tokens = estimateTokenCount({});
      // 只有开销 (20 tokens)
      expect(tokens).toBe(20);
    });

    test("should use cached value when available", () => {
      const sessionId = `cache-test-${Date.now()}`;
      // 预先缓存一个值
      cacheInputTokens(sessionId, 5000, 5);

      const body = {
        messages: [
          { role: "user" as const, content: "msg1" },
          { role: "assistant" as const, content: "response1" },
          { role: "user" as const, content: "msg2" },
          { role: "assistant" as const, content: "response2" },
          { role: "user" as const, content: "msg3" },
          // 新增的消息
          { role: "assistant" as const, content: "response3" },
          { role: "user" as const, content: "msg4" },
        ],
      };

      const tokens = estimateTokenCount(body, { sessionId });
      // 应该是缓存值 (5000) + 新增消息的估算
      expect(tokens).toBeGreaterThan(5000);
      expect(tokens).toBeLessThan(5100); // 新增消息不应该太多 tokens
    });
  });

  describe("createCountTokensResponse", () => {
    test("should create valid JSON response with context_management", () => {
      const response = createCountTokensResponse(1234);
      const parsed = JSON.parse(response);
      expect(parsed).toEqual({ context_management: null, input_tokens: 1234 });
    });
  });

  describe("extractUsageFromResponse", () => {
    test("should extract usage from Codex response", () => {
      const response = {
        id: "resp_xxx",
        status: "completed",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
        },
      };
      const usage = extractUsageFromResponse(response);
      expect(usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    });

    test("should return null for response without usage", () => {
      const response = { id: "resp_xxx", status: "completed" };
      expect(extractUsageFromResponse(response)).toBeNull();
    });

    test("should return null for invalid input", () => {
      expect(extractUsageFromResponse(null)).toBeNull();
      expect(extractUsageFromResponse(undefined)).toBeNull();
      expect(extractUsageFromResponse("string")).toBeNull();
    });
  });

  describe("extractUsageFromSSE", () => {
    test("should extract usage from SSE response.completed event", () => {
      const sseText = `event: response.created
data: {"type":"response.created","response":{"id":"resp_123"}}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"type":"message"}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_123","status":"completed","usage":{"input_tokens":2500,"output_tokens":150}}}

`;
      const usage = extractUsageFromSSE(sseText);
      expect(usage).toEqual({ inputTokens: 2500, outputTokens: 150 });
    });

    test("should return null when no response.completed event", () => {
      const sseText = `event: response.created
data: {"type":"response.created"}

event: response.output_item.added
data: {"type":"response.output_item.added"}

`;
      expect(extractUsageFromSSE(sseText)).toBeNull();
    });

    test("should return null for empty string", () => {
      expect(extractUsageFromSSE("")).toBeNull();
    });
  });
});
