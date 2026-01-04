/**
 * Task Executor - 后台执行 subagent 任务
 *
 * 当收到 run_in_background=true 的 Task 调用时：
 * 1. 立即返回 task_id 给主 agent
 * 2. 在后台发起新的 API 请求执行 subagent
 * 3. 解析响应并更新任务状态
 * 4. 当 TaskOutput 被调用时，返回缓存的结果
 */

import {
  getTask,
  markTaskRunning,
  markTaskCompleted,
  markTaskFailed,
  type TaskState,
  type TaskInput,
  type TaskCompletedResult,
} from "./task-manager";

import { convertRequest, convertHeaders, extractTargetModel } from "./request-converter";
import { SSEStreamConverter } from "./response-converter";
import type { ClaudeRequest, ClaudeMessage } from "./types";

/** 执行器配置 */
export interface TaskExecutorConfig {
  /** API 端点 URL（必须从请求中提取） */
  apiEndpoint: string;
  /** 请求头（必须包含认证头和 x-target-model） */
  headers: Record<string, string>;
  /** 调试模式 */
  debug?: boolean;
  /** 日志函数 */
  log?: (message: string) => void;
}

/** 占位符模型名（实际模型由 x-target-model header 决定） */
const PLACEHOLDER_MODEL = "gpt-5.2";

/**
 * 构建 subagent 请求
 *
 * 基于 Task 输入参数构建一个新的 Claude 请求。
 * 注意：model 字段只是占位符，最终模型由 x-target-model header 决定。
 */
export function buildSubagentRequest(taskInput: TaskInput): ClaudeRequest {
  // 根据 subagent_type 选择合适的系统提示
  const systemPrompt = getSubagentSystemPrompt(taskInput.subagent_type);

  // 构建消息
  const messages: ClaudeMessage[] = [
    {
      role: "user",
      content: taskInput.prompt,
    },
  ];

  return {
    model: PLACEHOLDER_MODEL,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
    stream: true,
    thinking: {
      type: "enabled",
      budget_tokens: 4096,
    },
  };
}

/**
 * 获取 subagent 类型对应的系统提示
 */
function getSubagentSystemPrompt(subagentType: string): string {
  const prompts: Record<string, string> = {
    Explore: `You are an expert codebase explorer. Your job is to quickly find files, search code, and understand project structure.

Focus on:
- Finding files matching patterns
- Searching for code patterns
- Understanding how things are implemented
- Providing concise, actionable answers

Be efficient and direct. Return relevant file paths and code snippets.`,

    Plan: `You are a software architect. Your job is to design implementation plans.

Focus on:
- Breaking down tasks into clear steps
- Identifying critical files and dependencies
- Considering architectural trade-offs
- Providing actionable implementation guidance`,

    "general-purpose": `You are a helpful coding assistant capable of complex multi-step research and reasoning.

Focus on:
- Thoroughly researching the codebase
- Combining search with analysis
- Providing comprehensive answers
- Explaining your reasoning`,

    code: `You are an expert software developer. Your job is to implement features directly.

Focus on:
- Writing clean, working code
- Following existing patterns in the codebase
- Making minimal, focused changes
- Testing your changes work`,

    bugfix: `You are a debugging expert. Your job is to analyze, understand, and fix bugs.

Focus on:
- Understanding the root cause
- Finding the minimal fix
- Avoiding regressions
- Explaining what went wrong`,

    debug: `You are a systematic debugger. Your job is to deeply analyze problems.

Focus on:
- Gathering evidence
- Forming hypotheses
- Testing assumptions
- Finding the root cause`,
  };

  return prompts[subagentType] || prompts["general-purpose"]!;
}

/**
 * 执行后台任务
 *
 * 在后台发起 API 请求，解析响应，更新任务状态
 */
export async function executeTask(
  taskId: string,
  config: TaskExecutorConfig
): Promise<void> {
  const task = getTask(taskId);
  if (!task) {
    console.error(`[TaskExecutor] Task not found: ${taskId}`);
    return;
  }

  if (!config.apiEndpoint) {
    markTaskFailed(taskId, "API endpoint not provided");
    return;
  }

  const log = config.log || ((msg: string) => {
    if (config.debug) {
      console.log(`[TaskExecutor] ${msg}`);
    }
  });

  log(`Starting task: ${taskId}`);
  log(`Subagent type: ${task.input.subagent_type}`);
  log(`Prompt: ${task.input.prompt.substring(0, 100)}...`);

  // 标记任务开始执行
  markTaskRunning(taskId);

  try {
    // 构建 subagent 请求（模型由 x-target-model header 决定）
    const claudeRequest = buildSubagentRequest(task.input);

    // 转换为 Codex 格式
    const targetModel = extractTargetModel(config.headers);
    const codexRequest = convertRequest(claudeRequest, { targetModel });
    const codexHeaders = convertHeaders(config.headers, { stream: true });

    log(`Sending request to: ${config.apiEndpoint}`);

    // 发起请求
    const response = await fetch(config.apiEndpoint, {
      method: "POST",
      headers: {
        ...codexHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify(codexRequest),
      signal: task.abortController?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`Request failed: ${response.status} ${errorText}`);
      markTaskFailed(taskId, `API request failed: ${response.status} ${errorText.substring(0, 200)}`);
      return;
    }

    // 处理 SSE 响应
    const contentType = response.headers.get("content-type") || "";
    let resultText = "";
    let usage = { input_tokens: 0, output_tokens: 0 };

    if (contentType.includes("text/event-stream")) {
      // SSE 响应
      const reader = response.body?.getReader();
      if (!reader) {
        markTaskFailed(taskId, "Failed to get response reader");
        return;
      }

      const decoder = new TextDecoder();
      const converter = new SSEStreamConverter();
      let fullSSE = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullSSE += chunk;
        converter.processChunk(chunk);
      }

      // 从 converter 状态提取结果
      const state = converter.getState();
      resultText = state.textContent;
      usage = {
        input_tokens: state.usage.inputTokens,
        output_tokens: state.usage.outputTokens,
      };

      log(`SSE response processed: ${resultText.length} chars`);
    } else {
      // JSON 响应
      const jsonResponse = await response.json();

      // 从 Codex 响应中提取文本
      if (jsonResponse.output && Array.isArray(jsonResponse.output)) {
        for (const item of jsonResponse.output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const content of item.content) {
              if (content.type === "output_text" && content.text) {
                resultText += content.text;
              }
            }
          }
        }
      }

      if (jsonResponse.usage) {
        usage = {
          input_tokens: jsonResponse.usage.input_tokens || 0,
          output_tokens: jsonResponse.usage.output_tokens || 0,
        };
      }

      log(`JSON response processed: ${resultText.length} chars`);
    }

    // 创建完成结果
    const result: TaskCompletedResult = {
      status: "completed",
      prompt: task.input.prompt,
      agentId: taskId,
      content: resultText ? [{ type: "text", text: resultText }] : [],
      totalToolUseCount: 0,
      totalDurationMs: Date.now() - task.createdAt,
      totalTokens: usage.input_tokens + usage.output_tokens,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
        cache_creation: null,
      },
    };

    markTaskCompleted(taskId, result);
    log(`Task completed: ${taskId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // 检查是否是取消错误
    if (error instanceof Error && error.name === "AbortError") {
      log(`Task aborted: ${taskId}`);
      // 任务已经被 killTask 标记为 killed，不需要再次更新
      return;
    }

    log(`Task failed: ${taskId} - ${errorMessage}`);
    markTaskFailed(taskId, errorMessage);
  }
}

/**
 * 启动后台任务执行
 *
 * 非阻塞，立即返回。任务在后台执行。
 */
export function startBackgroundTask(
  taskId: string,
  config: TaskExecutorConfig
): void {
  // 使用 Promise 确保异步执行，不阻塞调用者
  setImmediate(() => {
    executeTask(taskId, config).catch((error) => {
      console.error(`[TaskExecutor] Unhandled error in task ${taskId}:`, error);
    });
  });
}

/**
 * 从请求上下文创建执行器配置
 */
export function createConfigFromRequest(
  headers: Record<string, string>,
  apiEndpoint?: string
): TaskExecutorConfig {
  // 提取必要的头（认证 + 目标模型）
  const authHeaders: Record<string, string> = {};

  if (headers["authorization"]) {
    authHeaders["authorization"] = headers["authorization"];
  }
  if (headers["x-api-key"]) {
    authHeaders["x-api-key"] = headers["x-api-key"];
  }
  // 复制 x-target-model header，用于模型映射
  if (headers["x-target-model"]) {
    authHeaders["x-target-model"] = headers["x-target-model"];
  }

  if (!apiEndpoint) {
    throw new Error("API endpoint is required for task execution");
  }

  return {
    apiEndpoint,
    headers: authHeaders,
    debug: process.env.DEBUG_TASK_EXECUTOR === "1",
  };
}
