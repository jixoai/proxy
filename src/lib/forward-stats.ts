/**
 * 转发规则统计模块 - 函数式设计
 *
 * 数据流：
 * 1. RequestSample 是唯一的原始数据，key: forwardId
 * 2. 所有计算都是纯函数，输入 samples + forward 配置
 */

import { EventEmitter } from "node:events";

// ========== 常量 ==========

/** 内存缓存窗口（15 分钟） */
export const CACHE_WINDOW_MS = 15 * 60 * 1000;

/** 默认过滤窗口（5 分钟） */
export const FILTER_WINDOW_MS = 5 * 60 * 1000;

/** 过滤最大条数 */
export const FILTER_MAX_COUNT = 100;

/** 清理间隔（30 秒） */
const CLEANUP_INTERVAL_MS = 30 * 1000;

/** 自动排序防抖（10 秒） */
const AUTO_SORT_DEBOUNCE_MS = 10 * 1000;

/** 自动排序最小样本数 */
const AUTO_SORT_MIN_SAMPLES = 3;

/** BroadcastChannel 名称 */
const STATS_CHANNEL_NAME = "proxy-forward-stats";

// ========== 类型定义 ==========

/** 请求样本 - 唯一的原始数据 */
export interface RequestSample {
  /** 请求时间戳（用于时间窗口过滤） */
  timestamp: number;
  /** TTFB (ms): 从请求发出到收到响应头的耗时 */
  ttfbMs: number;
  /** res.ok() */
  success: boolean;
}

/** 计算后的健康度 */
export interface ComputedHealth {
  /** 失败率 0-1 */
  failureRate: number;
  /** 平均延迟 (ms) */
  avgLatency: number;
  /** 总请求数 */
  totalRequests: number;
  /** 失败请求数 */
  failedRequests: number;
  /** 健康度评分 0-100 */
  healthScore: number;
  /** 休眠因子 0-1（越大越“灰”，表示最近无请求） */
  dormancyFactor: number;
}

/** Forward 配置（用于评估） */
export interface ForwardMatcher {
  /** forward 唯一标识 */
  id: string;
  /** 在 instance.forwards 数组中的索引 */
  index: number;
}

/** 统计报告消息（从 worker 发送） */
export interface StatsReportMessage {
  type: "report";
  /** forward 唯一标识 */
  forwardId: string;
  timestamp: number;
  /** TTFB (ms): 从请求发出到收到响应头的耗时 */
  ttfbMs: number;
  success: boolean;
}

// ========== 纯函数 ==========

/**
 * 过滤时间窗口内的样本
 */
export function filterSamples(
  samples: RequestSample[],
  windowMs = FILTER_WINDOW_MS,
  maxCount = FILTER_MAX_COUNT,
  now = Date.now(),
): RequestSample[] {
  const cutoff = now - windowMs;
  const filtered = samples.filter((s) => s.timestamp >= cutoff);
  // 取最新的 maxCount 条
  return filtered.length > maxCount ? filtered.slice(-maxCount) : filtered;
}

/**
 * 清理过期样本（超过缓存窗口）
 */
export function cleanupExpiredSamples(
  samples: RequestSample[],
  cacheWindowMs = CACHE_WINDOW_MS,
  now = Date.now(),
): RequestSample[] {
  const cutoff = now - cacheWindowMs;
  return samples.filter((s) => s.timestamp >= cutoff);
}

/**
 * 计算健康度（从过滤后的样本）
 */
export function computeHealthFromSamples(samples: RequestSample[]): ComputedHealth {
  const total = samples.length;
  if (total === 0) {
    return {
      failureRate: 0,
      avgLatency: 0,
      totalRequests: 0,
      failedRequests: 0,
      healthScore: 50, // 无数据时中等评分
      dormancyFactor: 1,
    };
  }

  const failed = samples.filter((s) => !s.success).length;
  const failureRate = failed / total;
  const avgLatency = Math.round(samples.reduce((sum, s) => sum + s.ttfbMs, 0) / total);

  return {
    failureRate,
    avgLatency,
    totalRequests: total,
    failedRequests: failed,
    healthScore: Math.round(100 * (1 - failureRate)),
    dormancyFactor: 0,
  };
}

/**
 * 根据 forwardId 获取 samples 并计算健康度
 */
export function computeForwardHealth(
  forwardId: string,
  samplesMap: Map<string, RequestSample[]>,
  windowMs = FILTER_WINDOW_MS,
  maxCount = FILTER_MAX_COUNT,
  now = Date.now(),
): ComputedHealth {
  const samples = samplesMap.get(forwardId) ?? [];
  const filtered = filterSamples(samples, windowMs, maxCount, now);
  const health = computeHealthFromSamples(filtered);
  const lastCallTime = samples.length > 0 ? samples[samples.length - 1]!.timestamp : 0;
  if (lastCallTime > 0) {
    const age = Math.max(0, now - lastCallTime);
    const dormancyFactor = Math.min(1, age / windowMs);
    return { ...health, dormancyFactor };
  }
  return health;
}

/**
 * 评估一组 forwards，返回建议的排序
 */
export function evaluateForwards(
  forwards: ForwardMatcher[],
  samplesMap: Map<string, RequestSample[]>,
  windowMs = FILTER_WINDOW_MS,
  maxCount = FILTER_MAX_COUNT,
  now = Date.now(),
): { suggestedOrder: number[] | null; reason: string } {
  if (forwards.length < 2) {
    return { suggestedOrder: null, reason: "Less than 2 forwards" };
  }

  // 计算每个 forward 的健康度
  const healthData = forwards.map((f) => ({
    forward: f,
    health: computeForwardHealth(f.id, samplesMap, windowMs, maxCount, now),
  }));

  // 检查是否有足够样本
  const hasSufficientData = healthData.some((d) => d.health.totalRequests >= AUTO_SORT_MIN_SAMPLES);
  if (!hasSufficientData) {
    return {
      suggestedOrder: null,
      reason: `Insufficient samples (min: ${AUTO_SORT_MIN_SAMPLES})`,
    };
  }

  // 按健康度排序（样本不足的排后面）
  const sorted = [...healthData].sort((a, b) => {
    if (a.health.totalRequests < AUTO_SORT_MIN_SAMPLES) return 1;
    if (b.health.totalRequests < AUTO_SORT_MIN_SAMPLES) return -1;
    return b.health.healthScore - a.health.healthScore;
  });

  const currentOrder = forwards.map((f) => f.index);
  const newOrder = sorted.map((d) => d.forward.index);

  // 检查顺序是否有变化
  const orderChanged = newOrder.some((idx, i) => idx !== currentOrder[i]);
  if (!orderChanged) {
    return { suggestedOrder: null, reason: "Order unchanged" };
  }

  // 检查健康度差距是否超过阈值（15分）
  const currentBest = healthData.find((d) => d.forward.index === currentOrder[0]);
  const newBest = sorted[0];
  if (currentBest && newBest && currentBest.forward.index !== newBest.forward.index) {
    const scoreDiff = newBest.health.healthScore - currentBest.health.healthScore;
    if (scoreDiff < 15) {
      return {
        suggestedOrder: null,
        reason: `Score diff (${scoreDiff.toFixed(1)}) < 15, not significant`,
      };
    }
  }

  return {
    suggestedOrder: newOrder,
    reason: `Reorder by health score: [${currentOrder.join(",")}] -> [${newOrder.join(",")}]`,
  };
}

// ========== ForwardStatsStore ==========

/**
 * 转发统计存储
 *
 * 职责：
 * 1. 存储 RequestSample[]（按 forwardId）
 * 2. 自动清理过期数据
 * 3. 接收 BroadcastChannel 消息
 * 4. 触发事件通知
 */
export class ForwardStatsStore extends EventEmitter {
  private samplesMap = new Map<string, RequestSample[]>();
  private channel: BroadcastChannel | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private autoSortDebounceTimer: NodeJS.Timeout | null = null;
  private pendingAutoSortForwardIds = new Set<string>();

  /**
   * 初始化（仅用于发送端，如 proxy-server Worker）
   * 只创建 channel 用于发送，不监听消息
   */
  init(): void {
    if (this.channel) return;

    try {
      this.channel = new BroadcastChannel(STATS_CHANNEL_NAME);
      // 发送端不设置 onmessage，避免接收自己发送的消息
    } catch (error) {
      console.error("[ForwardStats] Failed to init BroadcastChannel:", error);
    }

    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * 启动监听（仅用于接收端，如 viewer-server 主进程）
   * 创建 channel 并监听消息
   */
  startListening(): void {
    if (this.channel) return;

    try {
      this.channel = new BroadcastChannel(STATS_CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<StatsReportMessage>) => {
        const message = event.data;
        if (message?.type === "report") {
          this.recordSample(message.forwardId, {
            timestamp: message.timestamp,
            ttfbMs: message.ttfbMs,
            success: message.success,
          });
        }
      };
    } catch (error) {
      console.error("[ForwardStats] Failed to start listening:", error);
    }

    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /** 关闭 */
  close(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.autoSortDebounceTimer) {
      clearTimeout(this.autoSortDebounceTimer);
      this.autoSortDebounceTimer = null;
    }
  }

  /** 记录样本 */
  recordSample(forwardId: string, sample: RequestSample): void {
    let samples = this.samplesMap.get(forwardId);
    if (!samples) {
      samples = [];
      this.samplesMap.set(forwardId, samples);
    }
    samples.push(sample);

    this.emit("samples-changed", { forwardId });

    // 失败时触发自动排序检查
    if (!sample.success) {
      this.scheduleAutoSort(forwardId);
    }
  }

  /** 发送报告（从 worker 调用） */
  sendReport(
    forwardId: string,
    timestamp: number,
    ttfbMs: number,
    success: boolean,
  ): void {
    if (!this.channel) return;

    const message: StatsReportMessage = {
      type: "report",
      forwardId,
      timestamp,
      ttfbMs,
      success,
    };

    this.channel.postMessage(message);
  }

  /** 获取所有样本（只读） */
  getSamplesMap(): Map<string, RequestSample[]> {
    return this.samplesMap;
  }

  /** 清理过期数据 */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, samples] of this.samplesMap) {
      const cleaned = cleanupExpiredSamples(samples, CACHE_WINDOW_MS, now);
      if (cleaned.length === 0) {
        this.samplesMap.delete(key);
      } else if (cleaned.length !== samples.length) {
        this.samplesMap.set(key, cleaned);
      }
    }
  }

  /** 调度自动排序检查（防抖） */
  private scheduleAutoSort(forwardId: string): void {
    this.pendingAutoSortForwardIds.add(forwardId);

    if (this.autoSortDebounceTimer) return;

    this.autoSortDebounceTimer = setTimeout(() => {
      this.autoSortDebounceTimer = null;
      const forwardIds = [...this.pendingAutoSortForwardIds];
      this.pendingAutoSortForwardIds.clear();

      this.emit("evaluation-needed", { forwardIds });
    }, AUTO_SORT_DEBOUNCE_MS);
  }

  /**
   * 获取用于前端显示的统计信息
   */
  getDisplayStats(): Array<{
    forwardId: string;
    lastCallTime: number;
    computed: ComputedHealth;
  }> {
    const result: Array<{ forwardId: string; lastCallTime: number; computed: ComputedHealth }> = [];
    const now = Date.now();

    for (const [forwardId, samples] of this.samplesMap) {
      const computed = computeForwardHealth(forwardId, this.samplesMap, FILTER_WINDOW_MS, FILTER_MAX_COUNT, now);
      const lastCallTime = samples.length > 0 ? samples[samples.length - 1]!.timestamp : 0;
      result.push({ forwardId, lastCallTime, computed });
    }

    return result;
  }
}

// 导出单例
export const forwardStatsStore = new ForwardStatsStore();
