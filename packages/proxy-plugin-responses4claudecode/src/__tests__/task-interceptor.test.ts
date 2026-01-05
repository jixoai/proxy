/**
 * Task Interceptor 测试
 */

import { describe, it, expect } from "bun:test";
import type { ClaudeMessage, ClaudeToolUseBlock, ClaudeToolResultBlock } from "../types";
import {
  extractTaskToolUses,
  extractTaskOutputToolUses,
  findToolResult,
  findPendingTaskToolUses,
  findPendingTaskOutputToolUses,
  handleTaskToolUse,
  interceptTaskTools,
} from "../task-interceptor";

describe("Task Interceptor", () => {
  describe("extractTaskToolUses", () => {
    it("should extract Task tool_use blocks from messages", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "user",
          content: "Find files",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Task",
              input: {
                description: "Find files",
                prompt: "Search for test files",
                subagent_type: "Explore",
              },
            },
          ],
        },
      ];

      const results = extractTaskToolUses(messages);
      expect(results).toHaveLength(1);
      expect(results[0]?.block.name).toBe("Task");
      expect(results[0]?.messageIndex).toBe(1);
    });

    it("should return empty array for no Task tools", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Read",
              input: { file_path: "/test.txt" },
            },
          ],
        },
      ];

      const results = extractTaskToolUses(messages);
      expect(results).toHaveLength(0);
    });
  });

  describe("extractTaskOutputToolUses", () => {
    it("should extract TaskOutput tool_use blocks", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_456",
              name: "TaskOutput",
              input: {
                task_id: "task_123",
                block: true,
              },
            },
          ],
        },
      ];

      const results = extractTaskOutputToolUses(messages);
      expect(results).toHaveLength(1);
      expect(results[0]?.block.name).toBe("TaskOutput");
    });
  });

  describe("findToolResult", () => {
    it("should find tool_result for tool_use_id", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Task",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "Result",
            },
          ],
        },
      ];

      const result = findToolResult(messages, "toolu_123");
      expect(result).not.toBeNull();
      expect(result?.tool_use_id).toBe("toolu_123");
    });

    it("should return null if no matching result", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Task",
              input: {},
            },
          ],
        },
      ];

      const result = findToolResult(messages, "toolu_123");
      expect(result).toBeNull();
    });
  });

  describe("findPendingTaskToolUses", () => {
    it("should find Task tool_use without corresponding result", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Task",
              input: {
                description: "Find files",
                prompt: "Search",
                subagent_type: "Explore",
                run_in_background: true,
              },
            },
          ],
        },
      ];

      const pending = findPendingTaskToolUses(messages);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe("toolu_123");
    });

    it("should not return Task tool_use that has a result", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Task",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "Result",
            },
          ],
        },
      ];

      const pending = findPendingTaskToolUses(messages);
      expect(pending).toHaveLength(0);
    });
  });

  describe("handleTaskToolUse", () => {
    it("should not intercept synchronous Task", () => {
      const block: ClaudeToolUseBlock = {
        type: "tool_use",
        id: "toolu_123",
        name: "Task",
        input: {
          description: "Find files",
          prompt: "Search",
          subagent_type: "Explore",
          run_in_background: false,
        },
      };

      const result = handleTaskToolUse(block, "session_123");
      expect(result.shouldIntercept).toBe(false);
    });

    it("should intercept async Task and create task state", () => {
      const block: ClaudeToolUseBlock = {
        type: "tool_use",
        id: "toolu_123",
        name: "Task",
        input: {
          description: "Find files",
          prompt: "Search for test files",
          subagent_type: "Explore",
          run_in_background: true,
        },
      };

      const result = handleTaskToolUse(block, "session_123");

      expect(result.shouldIntercept).toBe(true);
      expect(result.result).toContain("Async agent launched");
      expect(result.task).not.toBeUndefined();
      expect(result.task?.status).toBe("pending");
    });

    it("should return error for invalid input", () => {
      const block: ClaudeToolUseBlock = {
        type: "tool_use",
        id: "toolu_123",
        name: "Task",
        input: {},
      };

      const result = handleTaskToolUse(block, "session_123");

      expect(result.shouldIntercept).toBe(true);
      expect(result.result).toContain("Error");
    });
  });

  describe("interceptTaskTools", () => {
    it("should not modify when no pending Task/TaskOutput", async () => {
      const messages: ClaudeMessage[] = [
        {
          role: "user",
          content: "Hello",
        },
      ];

      const result = await interceptTaskTools(messages);
      expect(result.modified).toBe(false);
      expect(result.modifiedMessages).toBeUndefined();
    });

    it("should inject tool_result for pending async Task", async () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_async_task",
              name: "Task",
              input: {
                description: "Explore code",
                prompt: "Find files",
                subagent_type: "Explore",
                run_in_background: true,
              },
            },
          ],
        },
      ];

      const result = await interceptTaskTools(messages, { user_id: "test" });

      expect(result.modified).toBe(true);
      expect(result.modifiedMessages).toBeDefined();
      // Should have original message + new user message with tool_result
      expect(result.modifiedMessages!.length).toBe(2);

      // Check the injected user message contains tool_result
      const lastMessage = result.modifiedMessages![1];
      expect(lastMessage?.role).toBe("user");
      expect(Array.isArray(lastMessage?.content)).toBe(true);
      const content = lastMessage?.content as ClaudeToolResultBlock[];
      expect(content[0]?.type).toBe("tool_result");
      expect(content[0]?.tool_use_id).toBe("toolu_async_task");
      expect(content[0]?.content).toContain("Async agent launched");
    });

    it("should not modify for sync Task", async () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_sync_task",
              name: "Task",
              input: {
                description: "Explore code",
                prompt: "Find files",
                subagent_type: "Explore",
                run_in_background: false,
              },
            },
          ],
        },
      ];

      const result = await interceptTaskTools(messages);

      expect(result.modified).toBe(false);
    });
  });
});
