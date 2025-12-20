/**
 * 会话状态管理器
 * 使用内存 Map 维护活跃会话状态，支持 LRU 淘汰
 * 
 * 核心算法：
 * 1. 清理 ping 任务：遍历 messages，累积 hash，逐个清理前缀对话的 ping 任务
 * 2. 发起 ping 任务：截取到最后一个 cache_control 位置，累积 hash，启动任务
 */

import { createHash } from "crypto";
import type { SessionState, AnthropicRequestBody, Message, ContentBlock } from "./types";

const MAX_SESSIONS = 1000;

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private accessOrder: string[] = [];

  /**
   * 从请求中提取 session ID（如果有 header）
   */
  getSessionIdFromHeader(
    headers: Record<string, string | string[] | undefined>
  ): string | null {
    const sessionIdHeader = headers["x-session-id"];
    if (sessionIdHeader) {
      const id = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
      if (id) return id;
    }
    return null;
  }

  /**
   * 清理所有前缀对话的 ping 任务
   * 遍历 messages，累积 hash，逐个清理
   */
  clearPrefixSessions(body: AnthropicRequestBody): string[] {
    const clearedIds: string[] = [];
    let hash = this.getBaseHash(body);

    if (!body.messages || body.messages.length === 0) {
      return clearedIds;
    }

    for (const msg of body.messages) {
      hash = this.accumulateHash(hash, msg);
      const sessionId = hash.slice(0, 16);
      if (this.sessions.has(sessionId)) {
        this.delete(sessionId);
        clearedIds.push(sessionId);
      }
    }

    return clearedIds;
  }

  /**
   * 计算最终的 session ID（基于到最后一个 cache_control 的消息）
   * 返回 null 如果没有 cache_control
   */
  computeFinalSessionId(body: AnthropicRequestBody): string | null {
    const lastCacheIndex = this.findLastCacheControlIndex(body.messages);
    if (lastCacheIndex < 0) {
      return null;
    }

    let hash = this.getBaseHash(body);
    const messages = body.messages!.slice(0, lastCacheIndex + 1);

    for (const msg of messages) {
      hash = this.accumulateHash(hash, msg);
    }

    return hash.slice(0, 16);
  }

  /**
   * 获取基础 hash（基于 system + model）
   */
  private getBaseHash(body: AnthropicRequestBody): string {
    const hash = createHash("sha256");

    if (body.system) {
      const systemText = this.extractSystemText(body.system);
      hash.update(systemText);
    }

    if (body.model) {
      hash.update(body.model);
    }

    return hash.digest("hex");
  }

  /**
   * 累积 hash：将当前 hash 与消息内容（去除 cache_control）合并
   */
  private accumulateHash(currentHash: string, msg: Message): string {
    const hash = createHash("sha256");
    hash.update(currentHash);
    hash.update(msg.role);
    hash.update(this.extractMessageText(msg));
    return hash.digest("hex");
  }

  /**
   * 提取 system 文本（去除 cache_control）
   */
  private extractSystemText(system: string | ContentBlock[]): string {
    if (typeof system === "string") {
      return system;
    }
    return system.map((b) => ("text" in b ? String(b.text) : "")).join("");
  }

  /**
   * 提取消息文本（去除 cache_control）
   */
  private extractMessageText(msg: Message): string {
    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b) => b.type === "text" && "text" in b)
        .map((b) => String(b.text))
        .join("");
    }
    return "";
  }

  /**
   * 找到最后一个带 cache_control 的消息索引
   */
  private findLastCacheControlIndex(messages: Message[] | undefined): number {
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
   * 检查消息是否包含 cache_control
   */
  private messageHasCacheControl(msg: Message): boolean {
    if (typeof msg.content === "string") {
      return false;
    }
    if (Array.isArray(msg.content)) {
      return msg.content.some((b) => b.cache_control);
    }
    return false;
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, state: SessionState): void {
    if (!this.sessions.has(sessionId) && this.sessions.size >= MAX_SESSIONS) {
      this.evictOldest();
    }

    this.sessions.set(sessionId, state);
    this.updateAccessOrder(sessionId);
  }

  delete(sessionId: string): boolean {
    this.accessOrder = this.accessOrder.filter((id) => id !== sessionId);
    return this.sessions.delete(sessionId);
  }

  /**
   * 更新会话：重置 pingCount，更新 lastActiveTime 和 latestContextPayload
   * 如果是新会话，设置 createdAt；否则保留原来的 createdAt
   */
  touch(
    sessionId: string,
    body: AnthropicRequestBody,
    proxyUrl: string,
    targetUrl: string,
    headers: Record<string, string>
  ): SessionState {
    const existing = this.sessions.get(sessionId);
    const now = Date.now();

    const state: SessionState = {
      sessionId,
      createdAt: existing?.createdAt ?? now,
      lastActiveTime: now,
      pingCount: 0,
      latestContextPayload: body,
      proxyUrl,
      targetUrl,
      headers: this.extractPingHeaders(headers),
    };

    this.set(sessionId, state);
    return state;
  }

  /**
   * 提取用于 ping 请求的必要 headers
   */
  private extractPingHeaders(headers: Record<string, string>): Record<string, string> {
    const pingHeaders: Record<string, string> = {};
    const keepHeaders = [
      "authorization",
      "x-api-key",
      "anthropic-version",
      "anthropic-beta",
      "content-type",
    ];

    for (const key of keepHeaders) {
      const lowerKey = key.toLowerCase();
      if (headers[lowerKey]) {
        pingHeaders[lowerKey] = headers[lowerKey];
      }
    }

    if (!pingHeaders["content-type"]) {
      pingHeaders["content-type"] = "application/json";
    }

    return pingHeaders;
  }

  /**
   * 遍历所有会话
   */
  entries(): IterableIterator<[string, SessionState]> {
    return this.sessions.entries();
  }

  get size(): number {
    return this.sessions.size;
  }

  private updateAccessOrder(sessionId: string): void {
    this.accessOrder = this.accessOrder.filter((id) => id !== sessionId);
    this.accessOrder.push(sessionId);
  }

  private evictOldest(): void {
    if (this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift();
      if (oldest) {
        this.sessions.delete(oldest);
      }
    }
  }
}
