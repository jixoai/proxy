/**
 * 数据库变更通知系统 (模拟 SQLite update_hook)
 *
 * 使用 UDP 组播实现跨进程的数据库变更通知
 * - proxy-server 在写入数据库前发送通知
 * - viewer-server 监听通知并立即查询新数据
 */

import dgram from "node:dgram";
import { EventEmitter } from "node:events";

// 组播配置
const MULTICAST_ADDR = "239.255.0.1"; // 本地组播地址
const MULTICAST_PORT = 37890; // 自定义端口

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
  private socket: dgram.Socket | null = null;
  private processId: string;

  constructor(processId?: string) {
    this.processId = processId || `process-${process.pid}`;
  }

  /**
   * 初始化 UDP 组播发送器
   */
  init(): void {
    if (this.socket) return;

    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket.on("error", (err) => {
      console.error("[DbNotifier] Socket error:", err);
    });
    console.log(`[DbNotifier] Initialized (PID: ${this.processId})`);
  }

  /**
   * 通知数据库变更
   */
  notify(type: DbChangeNotification["type"], table: string, id?: number): void {
    if (!this.socket) return;

    const notification: DbChangeNotification = {
      type,
      table,
      id,
      timestamp: Date.now(),
      sender: this.processId,
    };

    const message = Buffer.from(JSON.stringify(notification));

    this.socket.send(message, MULTICAST_PORT, MULTICAST_ADDR, (err) => {
      if (err) {
        console.error("[DbNotifier] Failed to send notification:", err);
      } else {
        console.log(`[DbNotifier] Sent: ${type} ${table}${id ? ` #${id}` : ""}`);
      }
    });
  }

  /**
   * 关闭发送器
   */
  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      console.log("[DbNotifier] Closed");
    }
  }
}

/**
 * 数据库变更监听器
 * 在 viewer-server 中使用，监听数据库变更通知
 */
export class DbListener extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private processId: string;

  constructor(processId?: string) {
    super();
    this.processId = processId || `process-${process.pid}`;
  }

  /**
   * 启动监听
   */
  start(): void {
    if (this.socket) return;

    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    this.socket.on("error", (err) => {
      console.error("[DbListener] Socket error:", err);
    });

    this.socket.on("message", (msg) => {
      try {
        const notification: DbChangeNotification = JSON.parse(msg.toString());

        // 忽略自己发送的消息（如果 viewer-server 也会写数据库）
        if (notification.sender === this.processId) {
          return;
        }

        console.log(
          `[DbListener] Received: ${notification.type} ${notification.table}${notification.id ? ` #${notification.id}` : ""} from ${notification.sender}`
        );

        // 触发事件
        this.emit("change", notification);
        this.emit(notification.type, notification);
        this.emit(`${notification.table}:${notification.type}`, notification);
      } catch (error) {
        console.error("[DbListener] Failed to parse notification:", error);
      }
    });

    this.socket.on("listening", () => {
      const address = this.socket!.address();
      console.log(`[DbListener] Listening on ${address.address}:${address.port}`);

      // 加入组播组
      this.socket!.addMembership(MULTICAST_ADDR);
      console.log(`[DbListener] Joined multicast group ${MULTICAST_ADDR}`);
    });

    this.socket.bind(MULTICAST_PORT);
  }

  /**
   * 停止监听
   */
  stop(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      console.log("[DbListener] Stopped");
    }
  }
}

// 导出单例实例
export const dbNotifier = new DbNotifier();
export const dbListener = new DbListener();
