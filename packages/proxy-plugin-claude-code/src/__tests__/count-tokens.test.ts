import { describe, expect, test } from "bun:test";
import {
  estimateTokenCount,
  isCountTokensRequest,
  createCountTokensResponse,
} from "../count-tokens";

describe("count-tokens", () => {
  describe("isCountTokensRequest", () => {
    test("should return true for count_tokens URL", () => {
      expect(isCountTokensRequest("/v1/messages/count_tokens")).toBe(true);
      expect(isCountTokensRequest("/anthropic-codex/v1/messages/count_tokens?beta=true")).toBe(true);
    });

    test("should return false for regular messages URL", () => {
      expect(isCountTokensRequest("/v1/messages")).toBe(false);
      expect(isCountTokensRequest("/anthropic/v1/messages?beta=true")).toBe(false);
    });

    test("should return false for undefined", () => {
      expect(isCountTokensRequest(undefined)).toBe(false);
    });
  });

  describe("estimateTokenCount", () => {
    test("should count tokens for simple text message", () => {
      const body = {
        messages: [
          { role: "user" as const, content: "Hello, how are you?" },
        ],
      };
      const tokens = estimateTokenCount(body);
      expect(tokens).toBeGreaterThan(0);
      // "Hello, how are you?" is ~6 tokens + overhead
      expect(tokens).toBeLessThan(50);
    });

    test("should count tokens for Chinese text", () => {
      const body = {
        messages: [
          { role: "user" as const, content: "你好，世界！" },
        ],
      };
      const tokens = estimateTokenCount(body);
      // Chinese characters use more tokens per character
      expect(tokens).toBeGreaterThan(5);
    });

    test("should count tokens with system prompt", () => {
      const body = {
        system: "You are a helpful assistant.",
        messages: [
          { role: "user" as const, content: "Hi" },
        ],
      };
      const tokens = estimateTokenCount(body);
      expect(tokens).toBeGreaterThan(10);
    });

    test("should count tokens with tools", () => {
      const body = {
        messages: [{ role: "user" as const, content: "Hi" }],
        tools: [
          { name: "tool1", description: "A tool", input_schema: {} },
          { name: "tool2", description: "Another tool", input_schema: {} },
        ],
      };
      const tokens = estimateTokenCount(body);
      // Should include serialized tools tokens
      expect(tokens).toBeGreaterThan(30);
    });

    test("should handle empty body", () => {
      const tokens = estimateTokenCount({});
      // Just overhead (20 tokens)
      expect(tokens).toBe(20);
    });
  });

  describe("createCountTokensResponse", () => {
    test("should create valid JSON response", () => {
      const response = createCountTokensResponse(1234);
      const parsed = JSON.parse(response);
      expect(parsed).toEqual({ input_tokens: 1234 });
    });
  });
});
