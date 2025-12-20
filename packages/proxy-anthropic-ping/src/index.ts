#!/usr/bin/env bun
/**
 * @jixo/proxy-anthropic-ping
 *
 * Anthropic 缓存保活插件
 *
 * 功能：
 * - 会话态识别：通过 x-session-id header 或 context hash 识别会话
 * - 自动心跳：在缓存即将过期时发送最小化请求保活
 * - 经济熔断：超过最大 ping 次数后自动销毁会话
 *
 * 配置（通过 proxy-config.json 的 hooks.config 传递）：
 * - maxPings: 最大心跳次数（默认 12，约 1 小时）
 * - cacheTtlMs: 缓存 TTL（默认 300000，即 5 分钟，Anthropic 官方值）
 * - pingLeadTimeMs: 提前多久开始保活（默认 60000，即 1 分钟）
 * - pollingIntervalMs: 轮询间隔（默认 30000，即 30 秒）
 * - debug: 是否开启调试日志
 * - cancelPatterns: 取消保活的消息正则表达式数组
 */

import { definePlugin, getPluginConfigWithDefaults } from "@jixo/proxy-plugin";
import { createAnthropicPingPlugin } from "./plugin";
import type { CancelTrigger } from "./types";

export { AnthropicPingMiddleware } from "./ping-middleware";
export { SessionManager } from "./session-manager";
export { createAnthropicPingPlugin, type AnthropicPingPluginOptions } from "./plugin";
export type {
  SessionState,
  AnthropicRequestBody,
  PingPluginOptions,
  PingResult,
  TextBlock,
  Message,
  MessageRole,
  CacheControl,
  CancelTrigger,
} from "./types";

/** 插件配置类型 */
export interface AnthropicPingConfig {
  /** 最大心跳次数（默认 12，约 1 小时） */
  maxPings?: number;
  /** 缓存 TTL ms（默认 300000，即 5 分钟，Anthropic 官方值） */
  cacheTtlMs?: number;
  /** 提前多久开始保活 ms（默认 60000，即 1 分钟） */
  pingLeadTimeMs?: number;
  /** 轮询间隔 ms（默认 30000，即 30 秒） */
  pollingIntervalMs?: number;
  /** 是否开启调试日志 */
  debug?: boolean;
  /** 取消保活的消息正则表达式数组 */
  cancelPatterns?: string[];
  /** 取消保活的 header key */
  cancelHeaderKey?: string;
}

if (import.meta.main) {
  // 从环境变量 PLUGIN_CONFIG 读取配置
  const config = getPluginConfigWithDefaults({
    maxPings: 12,
    cacheTtlMs: 5 * 60 * 1000, // 5 分钟，Anthropic 官方值
    pingLeadTimeMs: 1 * 60 * 1000, // 提前 1 分钟开始保活
    pollingIntervalMs: 30 * 1000,
    debug: false,
    cancelPatterns: [] as string[],
    cancelHeaderKey: "",
  });

  // 也支持通过环境变量直接配置（向后兼容）
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1" || config.debug;
  const maxPings = process.env.MAX_PINGS ? parseInt(process.env.MAX_PINGS, 10) : config.maxPings;

  // 计算实际的 idle 阈值
  const idleThresholdMs = config.cacheTtlMs - config.pingLeadTimeMs;

  // 构建取消触发器
  const cancelTriggers: CancelTrigger[] = [];
  if (config.cancelPatterns) {
    for (const pattern of config.cancelPatterns) {
      cancelTriggers.push({ messagePattern: new RegExp(pattern, "i") });
    }
  }
  if (config.cancelHeaderKey) {
    cancelTriggers.push({ headerKey: config.cancelHeaderKey });
  }

  console.log("[AnthropicPing] Starting with config:", {
    maxPings,
    cacheTtlMs: config.cacheTtlMs,
    pingLeadTimeMs: config.pingLeadTimeMs,
    idleThresholdMs,
    pollingIntervalMs: config.pollingIntervalMs,
    cancelTriggers: cancelTriggers.length,
    debug,
  });

  definePlugin(
    createAnthropicPingPlugin({
      debug,
      maxPings,
      idleThresholdMs,
      pollingIntervalMs: config.pollingIntervalMs,
      cancelTriggers,
      onPing: (sessionId, pingCount) => {
        console.log(`[AnthropicPing] Ping sent: session=${sessionId}, count=${pingCount}`);
      },
      onExpire: (sessionId, reason) => {
        console.log(`[AnthropicPing] Session expired: session=${sessionId}, reason=${reason}`);
      },
      onCancel: (sessionId, trigger) => {
        console.log(`[AnthropicPing] Session cancelled: session=${sessionId}, trigger=${trigger}`);
      },
    }),
    { debug }
  );
}
