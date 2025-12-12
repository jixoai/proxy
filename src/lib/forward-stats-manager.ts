/**
 * 转发规则端点状态管理器
 *
 * 统计每个转发规则端点的:
 * - 失败率 (5分钟滑动窗口)
 * - 平均延迟
 * - 最后调用时间
 *
 * 支持:
 * - 颜色平滑过渡 (休眠状态渐变为灰色)
 * - 自动排序 (基于健康度评分)
 */

import { EventEmitter } from "node:events";
import { BroadcastChannel } from "node:worker_threads";

const STATS_CHANNEL_NAME = "proxy-forward-stats";
const STATS_WINDOW_MS = 5 * 60 * 1000; // 5分钟
const CLEANUP_INTERVAL_MS = 30 * 1000; // 30秒清理一次过期数据
const AUTO_SORT_DEBOUNCE_MS = 10 * 1000; // 自动排序防抖10秒
const AUTO_SORT_MIN_SAMPLES = 3; // 至少3个样本才参与排序

export interface RequestSample {
  timestamp: number;
  durationMs: number;
  success: boolean;
}

export interface ForwardEndpointStats {
  /** 实例名称 */
  instanceName: string;
  /** 转发规则名称 (同名规则共享统计) */
  forwardName: string;
  /** 目标端点索引 (区分同名规则的不同端点) */
  endpointIndex: number;
  /** 目标 URL */
  targetUrl: string;
  /** 5分钟内的请求样本 */
  samples: RequestSample[];
  /** 最后调用时间戳 */
  lastCallTime: number;
  /** 计算后的统计值 */
  computed: {
    /** 失败率 0-1 */
    failureRate: number;
    /** 平均延迟 ms */
    avgLatency: number;
    /** 总请求数 */
    totalRequests: number;
    /** 失败请求数 */
    failedRequests: number;
    /** 健康度评分 0-100 (用于排序) */
    healthScore: number;
    /** 休眠因子 0-1 (0=刚调用, 1=完全休眠) */
    dormancyFactor: number;
  };
}

export interface StatsUpdateMessage {
  type: "stats-update";
  instanceName: string;
  stats: ForwardEndpointStats[];
}

export interface StatsReportMessage {
  type: "report";
  instanceName: string;
  forwardName: string;
  endpointIndex: number;
  targetUrl: string;
  durationMs: number;
  success: boolean;
  timestamp: number;
}

export type StatsMessage = StatsUpdateMessage | StatsReportMessage;

/**
 * 计算健康度评分
 *
 * 评分规则:
 * - 延迟评分: 200ms以下满分, 200-1000ms线性下降, 1000ms以上低分
 * - 失败率评分: 0%失败满分, 100%失败0分
 * - 综合: 延迟 40% + 失败率 60%
 */
function calculateHealthScore(
  avgLatency: number,
  failureRate: number,
  totalRequests: number,
): number {
  if (totalRequests === 0) return 50; // 无数据时中等评分

  // 延迟评分 (0-100)
  let latencyScore: number;
  if (avgLatency <= 200) {
    latencyScore = 100;
  } else if (avgLatency <= 1000) {
    latencyScore = 100 - ((avgLatency - 200) / 800) * 70; // 200ms=100, 1000ms=30
  } else {
    latencyScore = Math.max(0, 30 - ((avgLatency - 1000) / 2000) * 30); // 1000ms=30, 3000ms=0
  }

  // 失败率评分 (0-100)
  const failureScore = (1 - failureRate) * 100;

  // 综合评分
  return Math.round(latencyScore * 0.4 + failureScore * 0.6);
}

/**
 * 计算休眠因子
 *
 * 0 = 刚刚调用
 * 1 = 超过5分钟没有调用 (完全休眠)
 */
function calculateDormancyFactor(lastCallTime: number, now: number): number {
  if (lastCallTime === 0) return 1;
  const elapsed = now - lastCallTime;
  if (elapsed <= 0) return 0;
  if (elapsed >= STATS_WINDOW_MS) return 1;
  return elapsed / STATS_WINDOW_MS;
}

export class ForwardStatsManager extends EventEmitter {
  private statsMap = new Map<string, ForwardEndpointStats>();
  private channel: BroadcastChannel | null = null;
  private cleanupTimer: NodeJS.Timer | null = null;
  private autoSortEnabled = true;
  private autoSortTimer: NodeJS.Timer | null = null;
  private pendingAutoSortInstances = new Set<string>();

  /** 生成唯一 key: instanceName/forwardName/endpointIndex */
  private makeKey(instanceName: string, forwardName: string, endpointIndex: number): string {
    return `${instanceName}/${forwardName}/${endpointIndex}`;
  }

  /** 初始化 BroadcastChannel 和清理定时器 */
  init(): void {
    if (this.channel) return;

    try {
      this.channel = new BroadcastChannel(STATS_CHANNEL_NAME);
      this.channel.onmessage = (event: any) => {
        const message = event.data as StatsMessage | undefined;
        if (!message) return;
        this.handleMessage(message);
      };
    } catch (error) {
      console.error("[ForwardStats] Failed to init BroadcastChannel:", error);
    }

    // 定期清理过期数据
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSamples(), CLEANUP_INTERVAL_MS);
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
    if (this.autoSortTimer) {
      clearTimeout(this.autoSortTimer);
      this.autoSortTimer = null;
    }
  }

  /** 设置自动排序开关 */
  setAutoSortEnabled(enabled: boolean): void {
    this.autoSortEnabled = enabled;
    if (!enabled && this.autoSortTimer) {
      clearTimeout(this.autoSortTimer);
      this.autoSortTimer = null;
      this.pendingAutoSortInstances.clear();
    }
  }

  isAutoSortEnabled(): boolean {
    return this.autoSortEnabled;
  }

  /** 处理来自 BroadcastChannel 的消息 */
  private handleMessage(message: StatsMessage): void {
    if (message.type === "report") {
      this.recordRequest(
        message.instanceName,
        message.forwardName,
        message.endpointIndex,
        message.targetUrl,
        message.durationMs,
        message.success,
        message.timestamp,
      );
    }
  }

  /**
   * 记录一次请求结果
   *
   * @param instanceName 实例名称
   * @param forwardName 转发规则名称
   * @param endpointIndex 端点索引 (同名规则中的第几个)
   * @param targetUrl 目标 URL
   * @param durationMs 请求耗时 ms
   * @param success 是否成功
   * @param timestamp 时间戳 (默认 now)
   */
  recordRequest(
    instanceName: string,
    forwardName: string,
    endpointIndex: number,
    targetUrl: string,
    durationMs: number,
    success: boolean,
    timestamp = Date.now(),
  ): void {
    const key = this.makeKey(instanceName, forwardName, endpointIndex);

    let stats = this.statsMap.get(key);
    if (!stats) {
      stats = {
        instanceName,
        forwardName,
        endpointIndex,
        targetUrl,
        samples: [],
        lastCallTime: 0,
        computed: {
          failureRate: 0,
          avgLatency: 0,
          totalRequests: 0,
          failedRequests: 0,
          healthScore: 50,
          dormancyFactor: 1,
        },
      };
      this.statsMap.set(key, stats);
    }

    stats.samples.push({ timestamp, durationMs, success });
    stats.lastCallTime = timestamp;
    stats.targetUrl = targetUrl;

    this.recomputeStats(stats, timestamp);

    // 触发自动排序 (防抖)
    if (this.autoSortEnabled && !success) {
      this.scheduleAutoSort(instanceName);
    }

    // 发送更新事件
    this.emit("stats-updated", instanceName);
  }

  /**
   * 发送统计报告消息 (用于从 proxy-server worker 发送)
   */
  sendReport(
    instanceName: string,
    forwardName: string,
    endpointIndex: number,
    targetUrl: string,
    durationMs: number,
    success: boolean,
  ): void {
    if (!this.channel) return;

    const message: StatsReportMessage = {
      type: "report",
      instanceName,
      forwardName,
      endpointIndex,
      targetUrl,
      durationMs,
      success,
      timestamp: Date.now(),
    };

    this.channel.postMessage(message);
  }

  /** 重新计算统计值 */
  private recomputeStats(stats: ForwardEndpointStats, now = Date.now()): void {
    const windowStart = now - STATS_WINDOW_MS;

    // 过滤窗口内的样本
    const validSamples = stats.samples.filter((s) => s.timestamp >= windowStart);
    stats.samples = validSamples;

    const total = validSamples.length;
    const failed = validSamples.filter((s) => !s.success).length;
    const avgLatency =
      total > 0 ? validSamples.reduce((sum, s) => sum + s.durationMs, 0) / total : 0;
    const failureRate = total > 0 ? failed / total : 0;

    stats.computed = {
      failureRate,
      avgLatency,
      totalRequests: total,
      failedRequests: failed,
      healthScore: calculateHealthScore(avgLatency, failureRate, total),
      dormancyFactor: calculateDormancyFactor(stats.lastCallTime, now),
    };
  }

  /** 清理过期样本 */
  private cleanupExpiredSamples(): void {
    const now = Date.now();
    for (const [, stats] of this.statsMap) {
      this.recomputeStats(stats, now);
    }
    this.emit("stats-updated", null); // 全局更新
  }

  /** 调度自动排序 (防抖) */
  private scheduleAutoSort(instanceName: string): void {
    this.pendingAutoSortInstances.add(instanceName);

    if (this.autoSortTimer) return;

    this.autoSortTimer = setTimeout(() => {
      this.autoSortTimer = null;
      const instances = [...this.pendingAutoSortInstances];
      this.pendingAutoSortInstances.clear();

      for (const name of instances) {
        this.emit("auto-sort-needed", name);
      }
    }, AUTO_SORT_DEBOUNCE_MS);
  }

  /**
   * 获取某个实例的所有端点统计
   */
  getInstanceStats(instanceName: string): ForwardEndpointStats[] {
    const now = Date.now();
    const result: ForwardEndpointStats[] = [];

    for (const [key, stats] of this.statsMap) {
      if (stats.instanceName !== instanceName) continue;
      this.recomputeStats(stats, now);
      result.push(stats);
    }

    return result;
  }

  /**
   * 获取某个转发规则名称下所有端点的统计
   */
  getForwardGroupStats(instanceName: string, forwardName: string): ForwardEndpointStats[] {
    const now = Date.now();
    const result: ForwardEndpointStats[] = [];

    for (const [, stats] of this.statsMap) {
      if (stats.instanceName !== instanceName || stats.forwardName !== forwardName) continue;
      this.recomputeStats(stats, now);
      result.push(stats);
    }

    return result.sort((a, b) => a.endpointIndex - b.endpointIndex);
  }

  /**
   * 计算同名规则组内的最优排序
   *
   * 算法:
   * 1. 如果样本数不足，保持原顺序
   * 2. 按健康度评分降序排列
   * 3. 只有当评分差距超过阈值时才重新排序
   */
  computeOptimalOrder(
    instanceName: string,
    forwardName: string,
    currentIndexes: number[],
  ): number[] | null {
    const stats = this.getForwardGroupStats(instanceName, forwardName);

    if (stats.length < 2) return null;

    // 检查是否有足够样本
    const hasSufficientData = stats.some((s) => s.computed.totalRequests >= AUTO_SORT_MIN_SAMPLES);
    if (!hasSufficientData) return null;

    // 按健康度评分排序
    const sorted = [...stats].sort((a, b) => {
      // 样本不足的排后面
      if (a.computed.totalRequests < AUTO_SORT_MIN_SAMPLES) return 1;
      if (b.computed.totalRequests < AUTO_SORT_MIN_SAMPLES) return -1;
      return b.computed.healthScore - a.computed.healthScore;
    });

    const newOrder = sorted.map((s) => s.endpointIndex);

    // 检查是否需要重新排序 (健康度差距超过 15 分)
    const currentBest = stats.find((s) => s.endpointIndex === currentIndexes[0]);
    const newBest = sorted[0];

    if (currentBest && newBest && currentBest.endpointIndex !== newBest.endpointIndex) {
      const scoreDiff = newBest.computed.healthScore - currentBest.computed.healthScore;
      if (scoreDiff < 15) {
        return null; // 差距不够大，不需要重排
      }
    }

    // 检查顺序是否有变化
    const orderChanged = newOrder.some((idx, i) => idx !== currentIndexes[i]);
    if (!orderChanged) return null;

    return newOrder;
  }

  /**
   * 获取用于前端显示的统计摘要
   */
  getDisplayStats(instanceName: string): Map<string, ForwardEndpointStats> {
    const result = new Map<string, ForwardEndpointStats>();
    const now = Date.now();

    for (const [key, stats] of this.statsMap) {
      if (stats.instanceName !== instanceName) continue;
      this.recomputeStats(stats, now);
      result.set(key, stats);
    }

    return result;
  }

  /**
   * 获取所有统计数据 (用于广播到前端)
   */
  getAllStats(): ForwardEndpointStats[] {
    const now = Date.now();
    const result: ForwardEndpointStats[] = [];

    for (const [, stats] of this.statsMap) {
      this.recomputeStats(stats, now);
      result.push(stats);
    }

    return result;
  }
}

// 导出单例
export const forwardStatsManager = new ForwardStatsManager();
