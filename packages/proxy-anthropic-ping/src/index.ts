#!/usr/bin/env bun
/**
 * @jixo/proxy-anthropic-ping
 *
 * Anthropic 缓存保活插件
 *
 * 功能：
 * - 会话态识别：通过 x-session-id header 或 context hash 识别会话
 * - 自动心跳：在缓存即将过期时发送最小化请求保活
 * - 时间限制：超过最大保活时长后自动停止
 * - 手动结束：发送 __PING_SESSION_END__ 消息立即停止保活并返回 204
 *
 * 配置（通过 proxy-config.json 的 hooks.config 传递）：
 * - maxKeepAliveDurationMs: 最大保活时长（默认 60 分钟）
 * - cacheTtlMs: 缓存 TTL（默认 5 分钟，Anthropic 官方值）
 * - pingLeadTimeMs: 提前多久开始保活（默认 1 分钟）
 * - pollingIntervalMs: 轮询间隔（默认 30 秒）
 * - debug: 是否开启调试日志
 */

import { definePlugin, getPluginConfigWithDefaults } from "@jixo/proxy-plugin";
import { createAnthropicPingPlugin } from "./plugin";

export { AnthropicPingMiddleware } from "./ping-middleware";
export { SessionManager } from "./session-manager";
export { createAnthropicPingPlugin, type AnthropicPingPluginOptions } from "./plugin";
export { DEFAULT_SKIP_PING_MATCHERS } from "./types";
export type { SkipPingMatcher } from "./types";
export type {
  SessionState,
  AnthropicRequestBody,
  PingPluginOptions,
  PingResult,
  TextBlock,
  Message,
  MessageRole,
  CacheControl,
} from "./types";

/** 插件配置类型 */
export interface AnthropicPingConfig {
  /** 最大保活时长 ms（默认 3600000，即 60 分钟） */
  maxKeepAliveDurationMs?: number;
  /** 缓存 TTL ms（默认 300000，即 5 分钟，Anthropic 官方值） */
  cacheTtlMs?: number;
  /** 提前多久开始保活 ms（默认 60000，即 1 分钟） */
  pingLeadTimeMs?: number;
  /** 轮询间隔 ms（默认 30000，即 30 秒） */
  pollingIntervalMs?: number;
  /** 是否开启调试日志 */
  debug?: boolean;
}

if (import.meta.main) {
  // 从环境变量 PLUGIN_CONFIG 读取配置
  const config = getPluginConfigWithDefaults({
    maxKeepAliveDurationMs: 60 * 60 * 1000, // 60 分钟
    cacheTtlMs: 5 * 60 * 1000, // 5 分钟，Anthropic 官方值
    pingLeadTimeMs: 1 * 60 * 1000, // 提前 1 分钟开始保活
    pollingIntervalMs: 30 * 1000,
    debug: false,
  });

  // 也支持通过环境变量直接配置（向后兼容）
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1" || config.debug;

  // 计算实际的 idle 阈值
  const idleThresholdMs = config.cacheTtlMs - config.pingLeadTimeMs;

  console.log("[AnthropicPing] Starting with config:", {
    maxKeepAliveDurationMs: config.maxKeepAliveDurationMs,
    cacheTtlMs: config.cacheTtlMs,
    pingLeadTimeMs: config.pingLeadTimeMs,
    idleThresholdMs,
    pollingIntervalMs: config.pollingIntervalMs,
    debug,
  });

  definePlugin(
    createAnthropicPingPlugin({
      debug,
      maxKeepAliveDurationMs: config.maxKeepAliveDurationMs,
      idleThresholdMs,
      pollingIntervalMs: config.pollingIntervalMs,
      onPing: (sessionId, pingCount) => {
        console.log(`[AnthropicPing] Ping sent: session=${sessionId}, count=${pingCount}`);
      },
      onExpire: (sessionId, reason) => {
        console.log(`[AnthropicPing] Session expired: session=${sessionId}, reason=${reason}`);
      },
    }),
    { debug }
  );
}
