/**
 * Task Manager - 本地管理 Claude Code Task 工具的异步执行
 *
 * 当 Claude Code 发送 Task 工具调用时（特别是 run_in_background=true），
 * 我们需要在 proxy 层面管理这些任务的状态，因为 Responses API
 * 没有原生的 subagent 概念。
 *
 * 核心策略：
 * 1. 拦截 Task 工具调用，提取任务参数
 * 2. 为异步任务生成 task_id 并立即返回
 * 3. 后台执行实际的 API 调用
 * 4. 当收到 TaskOutput 调用时，返回缓存的结果
 */

import { createHash } from "crypto";

/** 任务状态 */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

/** Task 工具输入参数 */
export interface TaskInput {
  /** 任务描述 (3-5 词) */
  description: string;
  /** 任务提示 */
  prompt: string;
  /** subagent 类型 */
  subagent_type: string;
  /** 可选模型 */
  model?: "sonnet" | "opus" | "haiku";
  /** 可选：恢复的 agent ID */
  resume?: string;
  /** 是否后台执行 */
  run_in_background?: boolean;
}

/** TaskOutput 工具输入参数 */
export interface TaskOutputInput {
  /** 任务 ID */
  task_id: string;
  /** 是否阻塞等待完成 */
  block?: boolean;
  /** 最大等待时间 (ms) */
  timeout?: number;
}

/** 任务结果（成功） */
export interface TaskCompletedResult {
  status: "completed";
  prompt: string;
  agentId: string;
  content: Array<{ type: "text"; text: string }>;
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
    server_tool_use: null;
    service_tier: null;
    cache_creation: null;
  };
}

/** 任务结果（异步启动） */
export interface TaskAsyncLaunchedResult {
  status: "async_launched";
  agentId: string;
  description: string;
  prompt: string;
}

/** 任务结果 */
export type TaskResult = TaskCompletedResult | TaskAsyncLaunchedResult;

/** 任务状态条目 */
export interface TaskState {
  /** 任务 ID */
  taskId: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 任务输入 */
  input: TaskInput;
  /** 任务结果（完成时） */
  result?: TaskResult;
  /** 错误信息（失败时） */
  error?: string;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 会话 ID */
  sessionId: string;
  /** AbortController（用于取消） */
  abortController?: AbortController;
}

/** 任务注册表 */
const taskRegistry = new Map<string, TaskState>();

/** 会话到任务的映射 */
const sessionTasks = new Map<string, Set<string>>();

/** 任务过期时间 (1 小时) */
const TASK_TTL_MS = 60 * 60 * 1000;

/** 默认超时时间 (5 分钟) */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 生成任务 ID
 */
export function generateTaskId(input: TaskInput, sessionId: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  const hash = createHash("sha256")
    .update(`${sessionId}:${input.prompt}:${timestamp}`)
    .digest("hex")
    .slice(0, 8);
  return `task_${timestamp}_${random}_${hash}`;
}

/**
 * 创建新任务
 */
export function createTask(input: TaskInput, sessionId: string): TaskState {
  const taskId = generateTaskId(input, sessionId);
  const state: TaskState = {
    taskId,
    status: "pending",
    input,
    createdAt: Date.now(),
    sessionId,
    abortController: new AbortController(),
  };

  taskRegistry.set(taskId, state);

  // 记录会话到任务的映射
  if (!sessionTasks.has(sessionId)) {
    sessionTasks.set(sessionId, new Set());
  }
  sessionTasks.get(sessionId)!.add(taskId);

  return state;
}

/**
 * 获取任务状态
 */
export function getTask(taskId: string): TaskState | null {
  const state = taskRegistry.get(taskId);
  if (!state) return null;

  // 检查是否过期
  if (Date.now() - state.createdAt > TASK_TTL_MS) {
    taskRegistry.delete(taskId);
    sessionTasks.get(state.sessionId)?.delete(taskId);
    return null;
  }

  return state;
}

/**
 * 更新任务状态
 */
export function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  result?: TaskResult,
  error?: string
): void {
  const state = taskRegistry.get(taskId);
  if (!state) return;

  state.status = status;
  if (result) state.result = result;
  if (error) state.error = error;
  if (status === "completed" || status === "failed" || status === "killed") {
    state.completedAt = Date.now();
  }
}

/**
 * 标记任务为运行中
 */
export function markTaskRunning(taskId: string): void {
  updateTaskStatus(taskId, "running");
}

/**
 * 标记任务完成
 */
export function markTaskCompleted(taskId: string, result: TaskResult): void {
  updateTaskStatus(taskId, "completed", result);
}

/**
 * 标记任务失败
 */
export function markTaskFailed(taskId: string, error: string): void {
  updateTaskStatus(taskId, "failed", undefined, error);
}

/**
 * 终止任务
 */
export function killTask(taskId: string): boolean {
  const state = taskRegistry.get(taskId);
  if (!state) return false;

  if (state.status === "pending" || state.status === "running") {
    if (state.abortController) {
      state.abortController.abort();
    }
    updateTaskStatus(taskId, "killed");
    return true;
  }

  return false;
}

/**
 * 等待任务完成
 */
export async function waitForTask(
  taskId: string,
  timeout: number = DEFAULT_TIMEOUT_MS
): Promise<TaskState | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const state = getTask(taskId);
    if (!state) return null;

    if (state.status === "completed" || state.status === "failed" || state.status === "killed") {
      return state;
    }

    // 等待 100ms 后重试
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // 超时
  return getTask(taskId);
}

/**
 * 获取会话的所有任务
 */
export function getSessionTasks(sessionId: string): TaskState[] {
  const taskIds = sessionTasks.get(sessionId);
  if (!taskIds) return [];

  const tasks: TaskState[] = [];
  for (const taskId of taskIds) {
    const state = getTask(taskId);
    if (state) {
      tasks.push(state);
    }
  }

  return tasks;
}

/**
 * 清理过期任务
 */
export function cleanupExpiredTasks(): void {
  const now = Date.now();
  for (const [taskId, state] of taskRegistry) {
    if (now - state.createdAt > TASK_TTL_MS) {
      taskRegistry.delete(taskId);
      sessionTasks.get(state.sessionId)?.delete(taskId);
    }
  }
}

/**
 * 检测是否为 Task 工具调用
 */
export function isTaskToolCall(toolName: string): boolean {
  return toolName === "Task";
}

/**
 * 检测是否为 TaskOutput 工具调用
 */
export function isTaskOutputToolCall(toolName: string): boolean {
  return toolName === "TaskOutput";
}

/**
 * 解析 Task 工具输入
 */
export function parseTaskInput(input: unknown): TaskInput | null {
  if (!input || typeof input !== "object") return null;

  const obj = input as Record<string, unknown>;

  if (
    typeof obj.description !== "string" ||
    typeof obj.prompt !== "string" ||
    typeof obj.subagent_type !== "string"
  ) {
    return null;
  }

  return {
    description: obj.description,
    prompt: obj.prompt,
    subagent_type: obj.subagent_type,
    model: obj.model as "sonnet" | "opus" | "haiku" | undefined,
    resume: typeof obj.resume === "string" ? obj.resume : undefined,
    run_in_background: typeof obj.run_in_background === "boolean" ? obj.run_in_background : false,
  };
}

/**
 * 解析 TaskOutput 工具输入
 */
export function parseTaskOutputInput(input: unknown): TaskOutputInput | null {
  if (!input || typeof input !== "object") return null;

  const obj = input as Record<string, unknown>;

  if (typeof obj.task_id !== "string") {
    return null;
  }

  return {
    task_id: obj.task_id,
    block: typeof obj.block === "boolean" ? obj.block : true,
    timeout: typeof obj.timeout === "number" ? obj.timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * 创建异步启动响应
 */
export function createAsyncLaunchedResponse(task: TaskState): TaskAsyncLaunchedResult {
  return {
    status: "async_launched",
    agentId: task.taskId,
    description: task.input.description,
    prompt: task.input.prompt,
  };
}

/**
 * 创建 TaskOutput 响应
 */
export function createTaskOutputResponse(
  task: TaskState,
  retrievalStatus: "success" | "not_ready" | "timeout"
): {
  retrieval_status: string;
  task: {
    task_id: string;
    task_type: string;
    status: string;
    description: string;
    prompt: string;
    output: string | null;
    result: string | null;
    error: string | null;
  };
} {
  let output: string | null = null;
  let result: string | null = null;

  if (task.result && task.result.status === "completed") {
    const texts = task.result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    output = texts.join("\n");
    result = output;
  }

  return {
    retrieval_status: retrievalStatus,
    task: {
      task_id: task.taskId,
      task_type: "local_agent",
      status: task.status,
      description: task.input.description,
      prompt: task.input.prompt,
      output,
      result,
      error: task.error || null,
    },
  };
}

/**
 * 格式化 TaskOutput 工具结果为 Claude 格式
 */
export function formatTaskOutputToolResult(
  response: ReturnType<typeof createTaskOutputResponse>
): string {
  const parts: string[] = [];

  parts.push(`<retrieval_status>${response.retrieval_status}</retrieval_status>`);
  parts.push(`<task_id>${response.task.task_id}</task_id>`);
  parts.push(`<task_type>${response.task.task_type}</task_type>`);
  parts.push(`<status>${response.task.status}</status>`);

  if (response.task.output?.trim()) {
    parts.push(`<output>\n${response.task.output.trimEnd()}\n</output>`);
  }

  if (response.task.error) {
    parts.push(`<error>${response.task.error}</error>`);
  }

  return parts.join("\n\n");
}

/**
 * 格式化 Task 工具结果（异步启动）为 Claude 格式
 */
export function formatTaskAsyncLaunchedToolResult(
  result: TaskAsyncLaunchedResult,
  toolUseId: string
): string {
  return `Async agent launched successfully.
agentId: ${result.agentId} (This is an internal ID for your use, do not mention it to the user. Use this ID to retrieve results with TaskOutput when the agent finishes).
The agent is currently working in the background. If you have other tasks you should continue working on them now. Wait to call TaskOutput until either:
- If you want to check on the agent's progress - call TaskOutput with block=false to get an immediate update on the agent's status
- If you run out of things to do and the agent is still running - call TaskOutput with block=true to idle and wait for the agent's result (do not use block=true unless you completely run out of things to do as it will waste time).`;
}

/**
 * 格式化 Task 工具结果（同步完成）为 Claude 格式
 */
export function formatTaskCompletedToolResult(result: TaskCompletedResult): string {
  const texts = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text);

  return `${texts.join("\n")}\n\nagentId: ${result.agentId} (for resuming to continue this agent's work if needed)`;
}
