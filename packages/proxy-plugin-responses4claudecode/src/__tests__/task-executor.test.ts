/**
 * Task Executor 测试
 */

import { describe, it, expect } from "bun:test";
import {
  buildSubagentRequest,
  createConfigFromRequest,
} from "../task-executor";
import type { TaskInput } from "../task-manager";

describe("Task Executor", () => {
  describe("buildSubagentRequest", () => {
    it("should build request for Explore subagent", () => {
      const input: TaskInput = {
        description: "Find files",
        prompt: "Search for test files",
        subagent_type: "Explore",
      };

      const request = buildSubagentRequest(input);

      // Model is placeholder (gpt-5.2), actual model from x-target-model header
      expect(request.model).toBe("gpt-5.2");
      expect(request.max_tokens).toBe(16384);
      expect(request.stream).toBe(true);
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0]?.role).toBe("user");
      expect(request.messages[0]?.content).toBe(input.prompt);
      expect(request.system).toContain("codebase explorer");
    });

    it("should build request for Plan subagent", () => {
      const input: TaskInput = {
        description: "Plan feature",
        prompt: "Design authentication system",
        subagent_type: "Plan",
      };

      const request = buildSubagentRequest(input);

      expect(request.system).toContain("software architect");
    });

    it("should ignore Task model parameter (x-target-model determines final model)", () => {
      const input: TaskInput = {
        description: "Quick task",
        prompt: "Do something",
        subagent_type: "Explore",
        model: "haiku", // This is ignored, x-target-model determines final model
      };

      const request = buildSubagentRequest(input);

      // model parameter is ignored, placeholder is used
      expect(request.model).toBe("gpt-5.2");
    });

    it("should include thinking configuration", () => {
      const input: TaskInput = {
        description: "Task",
        prompt: "Do something",
        subagent_type: "Explore",
      };

      const request = buildSubagentRequest(input);

      expect(request.thinking).toBeDefined();
      expect(request.thinking?.type).toBe("enabled");
      expect(request.thinking?.budget_tokens).toBe(4096);
    });
  });

  describe("createConfigFromRequest", () => {
    const testEndpoint = "https://test-api.example.com/v1/responses";

    it("should extract authorization header", () => {
      const headers = {
        authorization: "Bearer sk-test-key",
        "content-type": "application/json",
      };

      const config = createConfigFromRequest(headers, testEndpoint);

      expect(config.headers.authorization).toBe("Bearer sk-test-key");
      expect(config.headers["content-type"]).toBeUndefined();
      expect(config.apiEndpoint).toBe(testEndpoint);
    });

    it("should extract x-api-key header", () => {
      const headers = {
        "x-api-key": "sk-test-key",
      };

      const config = createConfigFromRequest(headers, testEndpoint);

      expect(config.headers["x-api-key"]).toBe("sk-test-key");
    });

    it("should extract x-target-model header", () => {
      const headers = {
        "authorization": "Bearer test",
        "x-target-model": "gpt-4o",
      };

      const config = createConfigFromRequest(headers, testEndpoint);

      expect(config.headers["x-target-model"]).toBe("gpt-4o");
    });

    it("should use provided API endpoint", () => {
      const headers = {
        authorization: "Bearer test",
      };

      const config = createConfigFromRequest(headers, "https://custom-api.example.com/v1/responses");

      expect(config.apiEndpoint).toBe("https://custom-api.example.com/v1/responses");
    });

    it("should throw error when endpoint not provided", () => {
      const headers = {};

      expect(() => createConfigFromRequest(headers)).toThrow("API endpoint is required");
    });
  });

  describe("subagent system prompts", () => {
    it("should use correct prompt for each subagent type", () => {
      const types = ["Explore", "Plan", "general-purpose", "code", "bugfix", "debug"];

      for (const type of types) {
        const input: TaskInput = {
          description: "Test",
          prompt: "Test",
          subagent_type: type,
        };

        const request = buildSubagentRequest(input);

        expect(request.system).toBeDefined();
        expect(typeof request.system).toBe("string");
        expect((request.system as string).length).toBeGreaterThan(50);
      }
    });

    it("should fall back to general-purpose for unknown types", () => {
      const input: TaskInput = {
        description: "Test",
        prompt: "Test",
        subagent_type: "unknown-type",
      };

      const request = buildSubagentRequest(input);

      expect(request.system).toContain("helpful coding assistant");
    });
  });
});
