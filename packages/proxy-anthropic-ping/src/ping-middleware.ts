/**
 * Anthropic 缓存保活中间件
 *
 * 功能：
 * 1. 拦截 Anthropic API 请求，识别并跟踪会话
 * 2. 全局轮询检测即将过期的缓存，自动发送心跳
 * 3. 超过最大保活时长后自动停止
 * 4. 收到 __PING_SESSION_END__ 消息时立即停止保活
 */

import { SessionManager } from "./session-manager";
import { PrivateHeaders } from "@jixo/proxy-plugin";
import jmespath from "jmespath";
import type {
  SessionState,
  AnthropicRequestBody,
  PingPluginOptions,
  PingResult,
  Message,
  SkipPingMatcher,
  SkipPingMatcherMap,
} from "./types";
import { DEFAULT_SKIP_PING_MATCHERS } from "./types";

const DEFAULT_MAX_KEEP_ALIVE_DURATION_MS = 60 * 60 * 1000; // 60 分钟
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟，Anthropic 官方值
const DEFAULT_PING_LEAD_TIME_MS = 1 * 60 * 1000; // 提前 1 分钟开始保活
const DEFAULT_IDLE_THRESHOLD_MS = DEFAULT_CACHE_TTL_MS - DEFAULT_PING_LEAD_TIME_MS; // 4 分钟
const DEFAULT_POLLING_INTERVAL_MS = 30 * 1000; // 30s

export class AnthropicPingMiddleware {
  private sessionManager = new SessionManager();
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  private readonly maxKeepAliveDurationMs: number;
  private readonly idleThresholdMs: number;
  private readonly pollingIntervalMs: number;
  private readonly debug: boolean;
  private readonly skipPingMatchers: ActiveSkipPingMatcher[];
  private readonly onPing?: (sessionId: string, pingCount: number) => void;
  private readonly onExpire?: (sessionId: string, reason: "timeout" | "manual") => void;

  constructor(options: PingPluginOptions = {}) {
    this.maxKeepAliveDurationMs = options.maxKeepAliveDurationMs ?? DEFAULT_MAX_KEEP_ALIVE_DURATION_MS;
    this.idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.pollingIntervalMs = options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    this.debug = options.debug ?? false;
    this.skipPingMatchers = this.normalizeSkipPingMatchers(options.skipPingMatchers);
    this.onPing = options.onPing;
    this.onExpire = options.onExpire;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log("[AnthropicPing]", ...args);
    }
  }

  /**
   * 处理用户真实请求
   * 
   * 核心算法：
   * 1. 检查是否是结束消息 __PING_SESSION_END__
   * 2. 清理所有前缀对话的 ping 任务（因为新请求覆盖了旧的上下文）
   * 3. 计算最终 session ID（基于到最后一个 cache_control 的消息）
   * 4. 如果有 cache_control，创建新的 ping 任务
   *
   * @param headers 请求头
   * @param body 请求体
   * @param proxyUrl Proxy URL（用于发送 ping 请求，走完整 proxy 流程）
   * @param targetUrl Target URL（回退用）
   */
  intercept(
    headers: Record<string, string>,
    body: AnthropicRequestBody,
    proxyUrl: string,
    targetUrl: string
  ): { sessionId: string | null; isNew: boolean; shouldReturn204: boolean; clearedCount: number } {
    // 1. 检查是否是结束消息
    if (this.isEndMessage(headers, body)) {
      const clearedIds = this.sessionManager.clearPrefixSessions(body);
      this.log(`End message received, cleared ${clearedIds.length} sessions`);
      for (const id of clearedIds) {
        this.onExpire?.(id, "manual");
      }
      return { sessionId: null, isNew: false, shouldReturn204: true, clearedCount: clearedIds.length };
    }

    // 2. 清理所有前缀对话的 ping 任务
    const clearedIds = this.sessionManager.clearPrefixSessions(body);
    if (clearedIds.length > 0) {
      this.log(`Cleared ${clearedIds.length} prefix sessions:`, clearedIds);
    }

    // 3. 计算最终 session ID（如果有 header 优先使用）
    const headerSessionId = this.sessionManager.getSessionIdFromHeader(headers);
    const sessionId = headerSessionId ?? this.sessionManager.computeFinalSessionId(body);

    // 如果没有 cache_control，不需要 ping 任务
    if (!sessionId) {
      this.log("No cache_control found, skipping ping task");
      return { sessionId: null, isNew: false, shouldReturn204: false, clearedCount: clearedIds.length };
    }

    // 4. 创建或更新 ping 任务
    const existing = this.sessionManager.get(sessionId);
    const isNew = !existing;

    this.sessionManager.touch(sessionId, body, proxyUrl, targetUrl, headers);
    this.log(`Session ${isNew ? "created" : "updated"}: ${sessionId}, proxyUrl: ${proxyUrl}`);

    if (!this.pollingTimer) {
      this.startPolling();
    }

    return { sessionId, isNew, shouldReturn204: false, clearedCount: clearedIds.length };
  }

  /**
   * 检查是否是结束保活的消息
   * 使用 JMESPath 查询 body，如果任意规则返回 truthy 则认为是结束消息
   */
  private isEndMessage(headers: Record<string, string>, body: AnthropicRequestBody): boolean {
    if (this.skipPingMatchers.length === 0) return false;

    // 预处理 messages，将 content 数组转换为纯文本以便 JMESPath 查询
    const normalizedBody = this.normalizeBodyForQuery(body);
    const requestContext = this.buildRequestContext(headers, normalizedBody);

    // 检查是否匹配任意规则
    return this.skipPingMatchers.some((matcher) => {
      switch (matcher.target) {
        case "requestBody":
          return this.matchJMESPath(normalizedBody, matcher.matcher);
        case "request":
          return this.matchJMESPath(requestContext, matcher.matcher);
        default:
          return false;
      }
    });
  }

  /**
   * 预处理 body，将 message.content 数组转换为纯文本字符串
   * 这样 JMESPath 查询时可以直接用 contains(content, 'xxx')
   */
  private normalizeBodyForQuery(body: AnthropicRequestBody): AnthropicRequestBody {
    if (!body.messages) return body;

    const normalizedMessages = body.messages.map((msg) => ({
      ...msg,
      content: this.extractMessageText(msg),
    }));

    return { ...body, messages: normalizedMessages };
  }

  private normalizeSkipPingMatchers(
    overrides: SkipPingMatcherMap | undefined
  ): ActiveSkipPingMatcher[] {
    const merged: SkipPingMatcherMap = {
      ...DEFAULT_SKIP_PING_MATCHERS,
      ...(overrides ?? {}),
    };
    return Object.values(merged).filter(isActiveSkipPingMatcher);
  }

  private buildRequestContext(
    headers: Record<string, string>,
    body: AnthropicRequestBody
  ): { headers: Record<string, string>; body: AnthropicRequestBody } {
    return { headers, body };
  }

  /**
   * 提取消息的文本内容
   */
  private extractMessageText(message: Message): string {
    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      const texts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text" && "text" in block) {
          texts.push(String(block.text));
        }
      }
      return texts.join("");
    }

    return "";
  }

  private buildResponseContext(response: Response): ResponseContext {
    return {
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      url: response.url,
      headers: this.headersToRecord(response.headers),
    };
  }

  private headersToRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  private parseResponseBody(text: string): unknown {
    if (!text) return "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * 使用 JMESPath 查询匹配
   */
  private matchJMESPath(target: unknown, expression: string): boolean {
    try {
      const result = jmespath.search(target, expression);
      // truthy 判断：非 null、非 undefined、非空字符串、非 false
      return Boolean(result);
    } catch (error) {
      this.log(`JMESPath query error for "${expression}":`, error);
      return false;
    }
  }

  /**
   * 检查响应是否匹配 skipPingMatchers 中的 response/responseBody 规则
   */
  private shouldStopOnResponse(responseContext: ResponseContext, responseBody: unknown): boolean {
    return this.skipPingMatchers.some((matcher) => {
      switch (matcher.target) {
        case "response":
          return this.matchJMESPath(responseContext, matcher.matcher);
        case "responseBody":
          return this.matchJMESPath(responseBody, matcher.matcher);
        default:
          return false;
      }
    });
  }

  /**
   * 启动全局轮询
   */
  startPolling(): void {
    if (this.pollingTimer) return;

    this.log("Starting global polling");
    this.pollingTimer = setInterval(() => {
      this.pollSessions().catch((err) => {
        console.error("[AnthropicPing] Polling error:", err);
      });
    }, this.pollingIntervalMs);
  }

  /**
   * 停止全局轮询
   */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.log("Stopped global polling");
    }
  }

  /**
   * 轮询所有会话，检查是否需要发送心跳
   */
  private async pollSessions(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const now = Date.now();
      const sessionsToExpire: string[] = [];
      const sessionsToPing: SessionState[] = [];

      for (const [sessionId, state] of this.sessionManager.entries()) {
        const sessionAge = now - state.createdAt;
        const idleTime = now - state.lastActiveTime;

        // 检查是否超过最大保活时长
        if (sessionAge >= this.maxKeepAliveDurationMs) {
          sessionsToExpire.push(sessionId);
          this.log(`Session ${sessionId} exceeded max keep-alive duration (${this.maxKeepAliveDurationMs}ms)`);
          continue;
        }

        // 检查是否需要发送心跳
        if (idleTime > this.idleThresholdMs) {
          sessionsToPing.push(state);
        }
      }

      for (const sessionId of sessionsToExpire) {
        this.sessionManager.delete(sessionId);
        this.onExpire?.(sessionId, "timeout");
      }

      for (const state of sessionsToPing) {
        await this.sendPing(state);
      }

      if (this.sessionManager.size === 0 && this.pollingTimer) {
        this.stopPolling();
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * 发送心跳请求
   * 使用 proxyUrl 发送，这样请求会走完整的 proxy 流程（包括其他插件处理和日志记录）
   */
  private async sendPing(state: SessionState): Promise<PingResult> {
    const { sessionId, latestContextPayload, proxyUrl, targetUrl, headers } = state;

    // 优先使用 proxyUrl，回退到 targetUrl
    const pingUrl = proxyUrl || targetUrl;

    try {
      const pingBody = this.buildPingPayload(latestContextPayload);
      this.log(`Sending ping for session ${sessionId} (count: ${state.pingCount + 1}) to ${pingUrl}`);

      // 添加私有 headers 标记这是一个心跳请求
      const pingHeaders: Record<string, string> = {
        ...headers,
        [PrivateHeaders.PLUGIN_ORIGIN]: "anthropic-ping",
        [PrivateHeaders.REQUEST_TYPE]: "ping",
        [PrivateHeaders.SESSION_ID]: sessionId,
        [PrivateHeaders.PING_COUNT]: String(state.pingCount + 1),
      };

      const response = await fetch(pingUrl, {
        method: "POST",
        headers: pingHeaders,
        body: JSON.stringify(pingBody),
      });

      const responseText = await response.text().catch(() => "");
      const responseBody = this.parseResponseBody(responseText);
      const responseContext = this.buildResponseContext(response);

      // 检查是否应该因为响应内容而停止 ping
      if (this.shouldStopOnResponse(responseContext, responseBody)) {
        this.log(`Stopping ping for session ${sessionId} due to response matcher (status ${response.status})`);
        this.sessionManager.delete(sessionId);
        this.onExpire?.(sessionId, "manual");
        return {
          success: false,
          sessionId,
          pingCount: state.pingCount,
          error: `Stopped due to response matcher (status ${response.status})`,
        };
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 200)}`);
      }

      state.pingCount++;
      state.lastActiveTime = Date.now();
      this.sessionManager.set(sessionId, state);

      this.log(`Ping successful for session ${sessionId}`);
      this.onPing?.(sessionId, state.pingCount);

      return { success: true, sessionId, pingCount: state.pingCount };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[AnthropicPing] Ping failed for session ${sessionId}:`, errorMessage);

      return { success: false, sessionId, pingCount: state.pingCount, error: errorMessage };
    }
  }

  /**
   * 构建心跳请求
   * 
   * 关键：保留原始请求的所有内容，只修改 messages
   * - 保留 model, system, tools, metadata 等所有字段
   * - 找到 messages 中最后一个带 cache_control 的位置
   * - 截断到那里，追加一个 "ping" message
   * - 设置 max_tokens: 1, stream: false 最小化响应
   */
  private buildPingPayload(original: AnthropicRequestBody): AnthropicRequestBody {
    // 找到最后一个带 cache_control 的 message 索引
    const lastCachedIndex = this.findLastCachedMessageIndex(original.messages);

    // 构建 messages：保留到最后一个 cached message + ping
    let messages: Message[];
    if (lastCachedIndex >= 0 && original.messages) {
      messages = [
        ...original.messages.slice(0, lastCachedIndex + 1),
        { role: "user" as const, content: "ping" },
      ];
    } else {
      // 没有 cache_control，只发一个 ping（不应该走到这里，但作为后备）
      messages = [{ role: "user" as const, content: "ping" }];
    }

    // 保留原始请求的所有字段，只修改 messages 和响应控制
    return {
      ...original,
      messages,
      max_tokens: 1,
      stream: false,
    };
  }

  /**
   * 找到 messages 中最后一个带 cache_control 的索引
   */
  private findLastCachedMessageIndex(messages: Message[] | undefined): number {
    if (!messages || messages.length === 0) return -1;

    let lastIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg && this.messageHasCacheControl(msg)) {
        lastIndex = i;
      }
    }
    return lastIndex;
  }

  /**
   * 检查 message 是否包含 cache_control
   */
  private messageHasCacheControl(message: Message): boolean {
    if (typeof message.content === "string") {
      return false;
    }
    if (!Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((block) => block.cache_control);
  }

  /**
   * 获取当前会话状态
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessionManager.get(sessionId);
  }

  /**
   * 获取所有活跃会话数量
   */
  getActiveSessionCount(): number {
    return this.sessionManager.size;
  }

  /**
   * 手动销毁会话
   */
  destroySession(sessionId: string): boolean {
    return this.sessionManager.delete(sessionId);
  }

  /**
   * 销毁所有会话并停止轮询
   */
  destroy(): void {
    this.stopPolling();
    for (const [sessionId] of this.sessionManager.entries()) {
      this.sessionManager.delete(sessionId);
    }
  }
}

type ResponseContext = {
  status: number;
  ok: boolean;
  statusText: string;
  url: string;
  headers: Record<string, string>;
};

type ActiveSkipPingMatcher = Exclude<SkipPingMatcher, { type: "skip" }>;

function isActiveSkipPingMatcher(matcher: SkipPingMatcher): matcher is ActiveSkipPingMatcher {
  return matcher.type !== "skip";
}
