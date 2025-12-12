/**
 * 数据库变更通知系统 (模拟 SQLite update_hook)
 *
 * 使用 BroadcastChannel 进行跨 worker 线程的数据库变更通知
 * - proxy-server 在写入数据库前发送通知
 * - viewer-server 监听通知并立即查询新数据
 */

import { EventEmitter } from "node:events";
import { BroadcastChannel } from "node:worker_threads";
import { createLogger } from "./logger";

const CHANNEL_NAME = "proxy-db-change";

// 通知消息类型
export interface DbChangeNotification {
  type: "insert" | "update" | "delete";
  table: string;
  id?: number;
  timestamp: number;
  sender: string; // 发送者进程 ID
}

/**
 * 数据库变更通知发送器
 * 在 proxy-server 中使用，发送数据库变更通知
 */
export class DbNotifier {
  private channel: BroadcastChannel | null = null;
  private processId: string;
  private readonly log = createLogger("proxy:db:notifier");

  constructor(processId?: string) {
    this.processId = processId || `process-${process.pid}`;
  }

  /**
   * 初始化通知发送器（仅 BroadcastChannel）
   */
  init(): void {
    if (this.channel) return;
    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.log.info("Using BroadcastChannel for notifications");
    } catch (error) {
      throw new Error(`[DbNotifier] Failed to init BroadcastChannel: ${String(error)}`);
    }
  }

  /**
   * 通知数据库变更
   */
  notify(type: DbChangeNotification["type"], table: string, id?: number): void {
    if (!this.channel) {
      this.log.error("notify called before init");
      return;
    }

    const notification: DbChangeNotification = {
      type,
      table,
      id,
      timestamp: Date.now(),
      sender: this.processId,
    };

    this.channel.postMessage(notification);
    this.log.debug(`[DbNotifier] Sent: ${type} ${table}${id ? ` #${id}` : ""}`);
  }

  /**
   * 关闭发送器
   */
  close(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
      this.log.debug("[DbNotifier] BroadcastChannel closed");
    }
  }
}

/**
 * 数据库变更监听器
 * 在 viewer-server 中使用，监听数据库变更通知
 */
export class DbListener extends EventEmitter {
  private channel: BroadcastChannel | null = null;
  private processId: string;
  private readonly log = createLogger("proxy:db:listener");

  constructor(processId?: string) {
    super();
    this.processId = processId || `process-${process.pid}`;
  }

  /**
   * 启动监听（BroadcastChannel）
   */
  start(): void {
    if (this.channel) return;

    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: any) => {
        const notification = event.data as DbChangeNotification | undefined;
        if (!notification) return;
        if (notification.sender === this.processId) return;

        this.emit("change", notification);
        this.emit(notification.type, notification);
        this.emit(`${notification.table}:${notification.type}`, notification);
      };
      this.log.info("Using BroadcastChannel for notifications");
    } catch (error) {
      throw new Error(`[DbListener] Failed to init BroadcastChannel: ${String(error)}`);
    }
  }

  /**
   * 停止监听
   */
  stop(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
      this.log.debug("[DbListener] BroadcastChannel stopped");
    }
  }
}

// 导出单例实例
export const dbNotifier = new DbNotifier();
export const dbListener = new DbListener();
