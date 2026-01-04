/**
 * Task Manager 测试
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createTask,
  getTask,
  markTaskRunning,
  markTaskCompleted,
  markTaskFailed,
  killTask,
  waitForTask,
  parseTaskInput,
  parseTaskOutputInput,
  createAsyncLaunchedResponse,
  createTaskOutputResponse,
  formatTaskAsyncLaunchedToolResult,
  formatTaskCompletedToolResult,
  formatTaskOutputToolResult,
  type TaskInput,
  type TaskCompletedResult,
} from "../task-manager";

describe("Task Manager", () => {
  const sessionId = "test-session-123";

  describe("createTask", () => {
    it("should create a new task with pending status", () => {
      const input: TaskInput = {
        description: "Test task",
        prompt: "Do something",
        subagent_type: "Explore",
        run_in_background: true,
      };

      const task = createTask(input, sessionId);

      expect(task.taskId).toMatch(/^task_/);
      expect(task.status).toBe("pending");
      expect(task.input).toEqual(input);
      expect(task.sessionId).toBe(sessionId);
      expect(task.createdAt).toBeGreaterThan(0);
    });
  });

  describe("getTask", () => {
    it("should return null for non-existent task", () => {
      const task = getTask("non-existent-task");
      expect(task).toBeNull();
    });

    it("should return task by ID", () => {
      const input: TaskInput = {
        description: "Test task",
        prompt: "Do something",
        subagent_type: "Explore",
      };

      const created = createTask(input, sessionId);
      const retrieved = getTask(created.taskId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.taskId).toBe(created.taskId);
    });
  });

  describe("task status updates", () => {
    it("should mark task as running", () => {
      const input: TaskInput = {
        description: "Test",
        prompt: "Test",
        subagent_type: "Explore",
      };

      const task = createTask(input, sessionId);
      markTaskRunning(task.taskId);

      const updated = getTask(task.taskId);
      expect(updated?.status).toBe("running");
    });

    it("should mark task as completed with result", () => {
      const input: TaskInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      const task = createTask(input, sessionId);
      markTaskRunning(task.taskId);

      const result: TaskCompletedResult = {
        status: "completed",
        prompt: input.prompt,
        agentId: task.taskId,
        content: [{ type: "text", text: "Task completed successfully" }],
        totalToolUseCount: 2,
        totalDurationMs: 1000,
        totalTokens: 500,
        usage: {
          input_tokens: 300,
          output_tokens: 200,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
      };

      markTaskCompleted(task.taskId, result);

      const updated = getTask(task.taskId);
      expect(updated?.status).toBe("completed");
      expect(updated?.result).toEqual(result);
      expect(updated?.completedAt).toBeGreaterThan(0);
    });

    it("should mark task as failed with error", () => {
      const input: TaskInput = {
        description: "Test",
        prompt: "Test",
        subagent_type: "Explore",
      };

      const task = createTask(input, sessionId);
      markTaskFailed(task.taskId, "Something went wrong");

      const updated = getTask(task.taskId);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Something went wrong");
    });

    it("should kill running task", () => {
      const input: TaskInput = {
        description: "Test",
        prompt: "Test",
        subagent_type: "Explore",
      };

      const task = createTask(input, sessionId);
      markTaskRunning(task.taskId);

      const killed = killTask(task.taskId);
      expect(killed).toBe(true);

      const updated = getTask(task.taskId);
      expect(updated?.status).toBe("killed");
    });
  });

  describe("parseTaskInput", () => {
    it("should parse valid Task input", () => {
      const input = {
        description: "Find files",
        prompt: "Search for test files",
        subagent_type: "Explore",
        model: "haiku" as const,
        run_in_background: true,
      };

      const parsed = parseTaskInput(input);
      expect(parsed).toEqual(input);
    });

    it("should return null for invalid input", () => {
      expect(parseTaskInput(null)).toBeNull();
      expect(parseTaskInput({})).toBeNull();
      expect(parseTaskInput({ description: "test" })).toBeNull();
    });

    it("should handle missing optional fields", () => {
      const input = {
        description: "Find files",
        prompt: "Search for test files",
        subagent_type: "Explore",
      };

      const parsed = parseTaskInput(input);
      expect(parsed?.run_in_background).toBe(false);
      expect(parsed?.model).toBeUndefined();
    });
  });

  describe("parseTaskOutputInput", () => {
    it("should parse valid TaskOutput input", () => {
      const input = {
        task_id: "task_123",
        block: false,
        timeout: 5000,
      };

      const parsed = parseTaskOutputInput(input);
      expect(parsed).toEqual(input);
    });

    it("should return null for missing task_id", () => {
      expect(parseTaskOutputInput({})).toBeNull();
      expect(parseTaskOutputInput({ block: true })).toBeNull();
    });

    it("should use defaults for optional fields", () => {
      const input = { task_id: "task_123" };

      const parsed = parseTaskOutputInput(input);
      expect(parsed?.block).toBe(true);
      expect(parsed?.timeout).toBe(300000); // 5 minutes default
    });
  });

  describe("response formatting", () => {
    it("should format async launched response", () => {
      const input: TaskInput = {
        description: "Find files",
        prompt: "Search for test files",
        subagent_type: "Explore",
        run_in_background: true,
      };

      const task = createTask(input, sessionId);
      const response = createAsyncLaunchedResponse(task);

      expect(response.status).toBe("async_launched");
      expect(response.agentId).toBe(task.taskId);
      expect(response.description).toBe(input.description);
      expect(response.prompt).toBe(input.prompt);
    });

    it("should format completed task output response", () => {
      const input: TaskInput = {
        description: "Test",
        prompt: "Test prompt",
        subagent_type: "Explore",
      };

      const task = createTask(input, sessionId);
      const result: TaskCompletedResult = {
        status: "completed",
        prompt: input.prompt,
        agentId: task.taskId,
        content: [{ type: "text", text: "Result text" }],
        totalToolUseCount: 0,
        totalDurationMs: 1000,
        totalTokens: 100,
        usage: {
          input_tokens: 50,
          output_tokens: 50,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
      };

      markTaskCompleted(task.taskId, result);
      const updated = getTask(task.taskId)!;

      const response = createTaskOutputResponse(updated, "success");

      expect(response.retrieval_status).toBe("success");
      expect(response.task.task_id).toBe(task.taskId);
      expect(response.task.status).toBe("completed");
      expect(response.task.output).toBe("Result text");
    });

    it("should format async launched tool result", () => {
      const input: TaskInput = {
        description: "Find files",
        prompt: "Search for test files",
        subagent_type: "Explore",
        run_in_background: true,
      };

      const task = createTask(input, sessionId);
      const response = createAsyncLaunchedResponse(task);
      const formatted = formatTaskAsyncLaunchedToolResult(response, "toolu_123");

      expect(formatted).toContain("Async agent launched successfully");
      expect(formatted).toContain(task.taskId);
      expect(formatted).toContain("TaskOutput");
    });

    it("should format completed task tool result", () => {
      const result: TaskCompletedResult = {
        status: "completed",
        prompt: "Test prompt",
        agentId: "task_123",
        content: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
        totalToolUseCount: 0,
        totalDurationMs: 1000,
        totalTokens: 100,
        usage: {
          input_tokens: 50,
          output_tokens: 50,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
      };

      const formatted = formatTaskCompletedToolResult(result);

      expect(formatted).toContain("Line 1");
      expect(formatted).toContain("Line 2");
      expect(formatted).toContain("task_123");
    });
  });

  describe("waitForTask", () => {
    it("should return immediately for completed task", async () => {
      const input: TaskInput = {
        description: "Test",
        prompt: "Test",
        subagent_type: "Explore",
      };

      const task = createTask(input, sessionId);
      markTaskCompleted(task.taskId, {
        status: "completed",
        prompt: input.prompt,
        agentId: task.taskId,
        content: [],
        totalToolUseCount: 0,
        totalDurationMs: 0,
        totalTokens: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
      });

      const result = await waitForTask(task.taskId, 100);
      expect(result?.status).toBe("completed");
    });

    it("should return null for non-existent task", async () => {
      const result = await waitForTask("non-existent", 100);
      expect(result).toBeNull();
    });

    it("should timeout for pending task", async () => {
      const input: TaskInput = {
        description: "Test",
        prompt: "Test",
        subagent_type: "Explore",
      };

      const task = createTask(input, sessionId);

      const start = Date.now();
      const result = await waitForTask(task.taskId, 200);
      const elapsed = Date.now() - start;

      expect(result?.status).toBe("pending");
      expect(elapsed).toBeGreaterThanOrEqual(150); // Should have waited ~200ms
    });
  });
});
