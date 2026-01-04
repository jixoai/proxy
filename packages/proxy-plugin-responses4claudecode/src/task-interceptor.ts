/**
 * Task Interceptor - 拦截和处理 Task/TaskOutput 工具调用
 *
 * 工作流程：
 *
 * 1. 请求阶段 (onRequest):
 *    - 检测最后一条 user 消息中是否有 tool_result 对应 Task 工具
 *    - 如果有待处理的 Task 结果，注入到响应中
 *
 * 2. 响应阶段 (onResponse):
 *    - 检测响应中是否有 Task/TaskOutput tool_use
 *    - 对于 Task(run_in_background=true)，创建本地任务并返回 task_id
 *    - 对于 TaskOutput，查找缓存的结果并返回
 *
 * 注意：由于 Responses API 没有原生的 subagent 支持，
 * 我们需要在 proxy 层面模拟 Claude Code 的异步任务行为。
 */

import type {
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeToolUseBlock,
  ClaudeToolResultBlock,
} from "./types";

import {
  createTask,
  getTask,
  markTaskCompleted,
  markTaskFailed,
  waitForTask,
  parseTaskInput,
  parseTaskOutputInput,
  createAsyncLaunchedResponse,
  createTaskOutputResponse,
  formatTaskAsyncLaunchedToolResult,
  formatTaskCompletedToolResult,
  formatTaskOutputToolResult,
  type TaskInput,
  type TaskState,
  type TaskCompletedResult,
} from "./task-manager";

import { extractSessionId } from "./token-cache";
import { startBackgroundTask, type TaskExecutorConfig } from "./task-executor";

/** 拦截结果 */
export interface InterceptResult {
  /** 是否需要修改请求（注入 tool_result） */
  modified: boolean;
  /** 修改后的消息（包含注入的 tool_result） */
  modifiedMessages?: ClaudeMessage[];
}

/**
 * 从消息中提取 Task tool_use 块
 */
export function extractTaskToolUses(
  messages: ClaudeMessage[]
): Array<{ block: ClaudeToolUseBlock; messageIndex: number }> {
  const results: Array<{ block: ClaudeToolUseBlock; messageIndex: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") continue;

    for (const block of message.content) {
      if (block.type === "tool_use" && block.name === "Task") {
        results.push({ block, messageIndex: i });
      }
    }
  }

  return results;
}

/**
 * 从消息中提取 TaskOutput tool_use 块
 */
export function extractTaskOutputToolUses(
  messages: ClaudeMessage[]
): Array<{ block: ClaudeToolUseBlock; messageIndex: number }> {
  const results: Array<{ block: ClaudeToolUseBlock; messageIndex: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") continue;

    for (const block of message.content) {
      if (block.type === "tool_use" && block.name === "TaskOutput") {
        results.push({ block, messageIndex: i });
      }
    }
  }

  return results;
}

/**
 * 查找对应的 tool_result
 */
export function findToolResult(
  messages: ClaudeMessage[],
  toolUseId: string
): ClaudeToolResultBlock | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") continue;

    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
        return block;
      }
    }
  }

  return null;
}

/**
 * 检测是否有未处理的 Task tool_use（没有对应的 tool_result）
 */
export function findPendingTaskToolUses(
  messages: ClaudeMessage[]
): ClaudeToolUseBlock[] {
  const taskToolUses = extractTaskToolUses(messages);
  const pending: ClaudeToolUseBlock[] = [];

  for (const { block } of taskToolUses) {
    const result = findToolResult(messages, block.id);
    if (!result) {
      pending.push(block);
    }
  }

  return pending;
}

/**
 * 检测是否有未处理的 TaskOutput tool_use
 */
export function findPendingTaskOutputToolUses(
  messages: ClaudeMessage[]
): ClaudeToolUseBlock[] {
  const taskOutputToolUses = extractTaskOutputToolUses(messages);
  const pending: ClaudeToolUseBlock[] = [];

  for (const { block } of taskOutputToolUses) {
    const result = findToolResult(messages, block.id);
    if (!result) {
      pending.push(block);
    }
  }

  return pending;
}

/**
 * 处理 Task 工具调用
 *
 * 策略：
 * - 对于 run_in_background=false（默认）: 让请求正常发送，Responses API 会处理
 * - 对于 run_in_background=true: 创建本地任务，立即返回 task_id
 */
export function handleTaskToolUse(
  block: ClaudeToolUseBlock,
  sessionId: string
): {
  shouldIntercept: boolean;
  result?: string;
  task?: TaskState;
} {
  const input = parseTaskInput(block.input);
  if (!input) {
    return {
      shouldIntercept: true,
      result: "Error: Invalid Task input parameters",
    };
  }

  // 对于同步任务，不拦截，让请求正常发送
  if (!input.run_in_background) {
    return { shouldIntercept: false };
  }

  // 对于异步任务，创建本地任务并返回
  const task = createTask(input, sessionId);
  const asyncResult = createAsyncLaunchedResponse(task);

  return {
    shouldIntercept: true,
    result: formatTaskAsyncLaunchedToolResult(asyncResult, block.id),
    task,
  };
}

/**
 * 处理 TaskOutput 工具调用
 */
export async function handleTaskOutputToolUse(
  block: ClaudeToolUseBlock
): Promise<{
  shouldIntercept: boolean;
  result?: string;
}> {
  const input = parseTaskOutputInput(block.input);
  if (!input) {
    return {
      shouldIntercept: true,
      result: "Error: Invalid TaskOutput input parameters - task_id is required",
    };
  }

  const task = getTask(input.task_id);
  if (!task) {
    return {
      shouldIntercept: true,
      result: `Error: No task found with ID: ${input.task_id}`,
    };
  }

  // 如果是非阻塞请求
  if (input.block === false) {
    if (task.status === "completed" || task.status === "failed" || task.status === "killed") {
      const response = createTaskOutputResponse(task, "success");
      return {
        shouldIntercept: true,
        result: formatTaskOutputToolResult(response),
      };
    }

    // 任务还在运行
    const response = createTaskOutputResponse(task, "not_ready");
    return {
      shouldIntercept: true,
      result: formatTaskOutputToolResult(response),
    };
  }

  // 阻塞等待任务完成
  const completedTask = await waitForTask(input.task_id, input.timeout);
  if (!completedTask) {
    return {
      shouldIntercept: true,
      result: `Error: Task ${input.task_id} not found or expired`,
    };
  }

  if (completedTask.status === "completed" || completedTask.status === "failed" || completedTask.status === "killed") {
    const response = createTaskOutputResponse(completedTask, "success");
    return {
      shouldIntercept: true,
      result: formatTaskOutputToolResult(response),
    };
  }

  // 超时
  const response = createTaskOutputResponse(completedTask, "timeout");
  return {
    shouldIntercept: true,
    result: formatTaskOutputToolResult(response),
  };
}

/** 拦截选项 */
export interface InterceptOptions {
  /** 执行器配置（后台执行时必需） */
  executorConfig?: TaskExecutorConfig;
  /** 是否启用后台执行 */
  enableBackgroundExecution?: boolean;
}

/**
 * 拦截请求中的 Task/TaskOutput 工具调用
 *
 * 策略：检测 pending 的 Task/TaskOutput tool_use，处理它们，
 * 然后注入 tool_result 到 messages 中，让请求继续发送到后端。
 *
 * 返回值：
 * - modified=true: 请求已被修改，需要使用 modifiedMessages
 * - modified=false: 请求不需要修改
 */
export async function interceptTaskTools(
  messages: ClaudeMessage[],
  metadata?: { user_id?: string },
  options?: InterceptOptions
): Promise<InterceptResult> {
  const sessionId = extractSessionId(metadata);
  const enableBackgroundExecution = options?.enableBackgroundExecution ?? true;
  const toolResultsToInject: Array<ClaudeToolResultBlock> = [];

  // 1. 检测未处理的 TaskOutput 调用
  const pendingTaskOutputs = findPendingTaskOutputToolUses(messages);
  for (const block of pendingTaskOutputs) {
    const result = await handleTaskOutputToolUse(block);
    if (result.shouldIntercept && result.result) {
      toolResultsToInject.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.result,
        is_error: result.result.startsWith("Error:"),
      });
    }
  }

  // 2. 检测未处理的 Task 调用（只处理 run_in_background=true）
  const pendingTasks = findPendingTaskToolUses(messages);
  for (const block of pendingTasks) {
    const result = handleTaskToolUse(block, sessionId);
    if (result.shouldIntercept && result.result) {
      toolResultsToInject.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.result,
        is_error: result.result.startsWith("Error:"),
      });

      // 如果创建了后台任务，启动后台执行
      if (result.task && enableBackgroundExecution && options?.executorConfig) {
        startBackgroundTask(result.task.taskId, options.executorConfig);
      }
    }
  }

  // 如果有 tool_result 需要注入
  if (toolResultsToInject.length > 0) {
    // 复制 messages 并注入 tool_result
    const modifiedMessages = [...messages];

    // 添加一个 user 消息包含所有 tool_result
    modifiedMessages.push({
      role: "user",
      content: toolResultsToInject,
    });

    return {
      modified: true,
      modifiedMessages,
    };
  }

  return { modified: false };
}

/**
 * 创建工具结果响应（Claude SSE 格式）
 */
export function createToolResultSSEResponse(
  toolResults: Array<{
    toolUseId: string;
    content: string;
    isError?: boolean;
  }>,
  messageId: string = `msg_${Date.now().toString(36)}`,
  model: string = "gpt-5.2"
): string {
  const events: string[] = [];

  // message_start
  events.push(`event:message_start
data:${JSON.stringify({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })}

`);

  let blockIndex = 0;

  for (const result of toolResults) {
    // 创建一个 text block 包含工具结果
    // 注意：这里我们直接返回文本，让 Claude Code 处理
    events.push(`event:content_block_start
data:${JSON.stringify({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "text",
        text: "",
      },
    })}

`);

    events.push(`event:content_block_delta
data:${JSON.stringify({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "text_delta",
        text: result.content,
      },
    })}

`);

    events.push(`event:content_block_stop
data:${JSON.stringify({
      type: "content_block_stop",
      index: blockIndex,
    })}

`);

    blockIndex++;
  }

  // message_delta
  events.push(`event:message_delta
data:${JSON.stringify({
    type: "message_delta",
    delta: {
      stop_reason: "end_turn",
      stop_sequence: null,
    },
    usage: {
      input_tokens: 0,
      output_tokens: toolResults.reduce((sum, r) => sum + Math.ceil(r.content.length / 4), 0),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })}

`);

  // message_stop
  events.push(`event:message_stop
data:${JSON.stringify({
    type: "message_stop",
  })}

`);

  return events.join("");
}

/**
 * 更新任务结果（从 Responses API 响应中提取）
 *
 * 当后台任务完成时调用此函数更新任务状态
 */
export function updateTaskFromResponse(
  taskId: string,
  response: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: string;
  }
): void {
  const task = getTask(taskId);
  if (!task) return;

  if (response.error) {
    markTaskFailed(taskId, response.error);
    return;
  }

  const content = (response.content || [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text)
    .map((c) => ({ type: "text" as const, text: c.text }));

  const result: TaskCompletedResult = {
    status: "completed",
    prompt: task.input.prompt,
    agentId: taskId,
    content,
    totalToolUseCount: 0,
    totalDurationMs: Date.now() - task.createdAt,
    totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    usage: {
      input_tokens: response.usage?.input_tokens || 0,
      output_tokens: response.usage?.output_tokens || 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  };

  markTaskCompleted(taskId, result);
}
