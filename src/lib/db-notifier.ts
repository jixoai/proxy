/**
 * 数据库变更通知系统 (模拟 SQLite update_hook)
 *
 * 使用 BroadcastChannel 进行跨 worker 线程的数据库变更通知
 * - proxy-server 在写入数据库前发送通知
 * - viewer-server 监听通知并立即查询新数据
 */

import { EventEmitter } from "node:events";
import { BroadcastChannel, threadId, isMainThread } from "node:worker_threads";
import createDebug from "debug";
import { createLogger } from "./logger";

const debugNotifier = createDebug("plugins:db-notifier");
const CHANNEL_NAME = "proxy-db-change";
const THREAD_ID = isMainThread ? "main" : `worker-${threadId}`;

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
    this.processId = processId || THREAD_ID;
  }

  /**
   * 初始化通知发送器（仅 BroadcastChannel）
   */
  init(): void {
    if (this.channel) return;
    try {
      debugNotifier("DbNotifier.init() called, channel name: %s", CHANNEL_NAME);
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

    debugNotifier("notify() called: type=%s table=%s id=%d", type, table, id);
    debugNotifier("channel exists: %s, posting message...", !!this.channel);

    const notification: DbChangeNotification = {
      type,
      table,
      id,
      timestamp: Date.now(),
      sender: THREAD_ID,
    };

    this.channel.postMessage(notification);
    debugNotifier("message posted to BroadcastChannel");
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
    this.processId = processId || THREAD_ID;
  }

  /**
   * 启动监听（BroadcastChannel）
   */
  start(): void {
    if (this.channel) return;

    try {
      debugNotifier("DbListener.start() called, processId: %s", this.processId);
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      debugNotifier("listening on channel: %s", CHANNEL_NAME);

      this.channel.onmessage = (event: any) => {
        // 添加日志：确认 onmessage 被触发
        debugNotifier("onmessage fired! event type: %s", typeof event);
        debugNotifier("event.data: %o", event.data);
        debugNotifier("event itself: %o", event);

        const notification = event.data as DbChangeNotification | undefined;
        if (!notification) {
          this.log.warn("[DbListener] Received message but no data:", { event, eventData: event.data });
          return;
        }

        debugNotifier("received message: %o", notification);
        debugNotifier("my processId: %s, sender: %s, same: %s",
          this.processId, notification.sender, notification.sender === this.processId);

        if (notification.sender === this.processId) return;

        this.emit("change", notification);
        this.emit(notification.type, notification);
        this.emit(`${notification.table}:${notification.type}`, notification);
      };

      debugNotifier("onmessage handler attached: %s", typeof this.channel.onmessage);
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
