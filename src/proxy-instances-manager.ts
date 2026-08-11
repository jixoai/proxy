import { EventEmitter } from "node:events";
import {
  ProxyManager,
  type ProxyStatus,
  type ProxyLogMessage,
  type ForwardConfig,
} from "./proxy-manager";
import { getAllInstances, getNormalizedForwards } from "./lib/config-store";
import { killPort } from "./lib/kill-port";
import { createLogger, type Logger } from "./lib/logger";
import type { InstanceRuntimeConfig } from "./types/worker-messages";

/** 端口清理后等待时间（毫秒） */
const PORT_CLEANUP_DELAY_MS = 500;

/** 实例状态变更事件 */
export interface InstanceStatusEvent {
  instanceName: string;
  status: ProxyStatus;
}

/** 端口占用错误的关键词列表 */
const PORT_IN_USE_KEYWORDS = [
  "EADDRINUSE",
  "address already in use",
  "Is port",
  "port in use",
  "Failed to start server",
];

type LogCallback = (log: ProxyLogMessage) => void;

/**
 * 检查错误是否为端口占用错误
 */
function isPortInUseError(error: unknown): boolean {
  const errorMsg = error instanceof Error ? error.message : String(error);
  return PORT_IN_USE_KEYWORDS.some((keyword) => errorMsg.includes(keyword));
}

/**
 * 将配置中的转发规则转换为 ForwardConfig 格式
 */
function toForwardConfigs(instanceName: string): ForwardConfig[] {
  return getNormalizedForwards(instanceName).map((f) => ({
    id: f.id!,
    name: f.name,
    target: f.target,
    enabled: f.enabled,
    description: f.description ?? null,
    path: f.path ?? null,
    methods: f.methods && f.methods.length ? f.methods : ["*"],
    headers: f.headers ?? null,
    hooks: f.hooks ?? null,
    orderLocked: f.orderLocked ?? false,
  }));
}

/**
 * 代理实例管理器
 * 管理所有代理实例的生命周期，包括启动、停止、重载等操作
 */
export class ProxyInstancesManager extends EventEmitter {
  private managers = new Map<string, ProxyManager>();
  private logCallbacks = new Set<LogCallback>();
  private readonly log: Logger = createLogger("proxy:instances");

  constructor() {
    super();
  }

  /** 广播实例状态变更 */
  private emitStatusChange(instanceName: string): void {
    const status = this.getInstanceStatus(instanceName);
    this.emit("instance-state-changed", { instanceName, status } as InstanceStatusEvent);
  }

  /** 广播实例配置同步状态变更 */
  private async emitConfigChange(instanceName: string): Promise<void> {
    const synced = await this.checkInstanceConfigSync(instanceName);
    this.emit("instance-config-change", { instanceName, synced });
  }

  /** 广播所有实例状态 */
  emitAllStatuses(): void {
    const instances = getAllInstances();
    const statuses: Record<string, ProxyStatus> = {};
    for (const instance of instances) {
      statuses[instance.name] = this.getInstanceStatus(instance.name);
    }
    this.emit("all-statuses", statuses);
  }

  /**
   * 启动指定实例
   * 如果端口被占用，会尝试清理后重试
   */
  async startInstance(instanceName: string): Promise<void> {
    const instance = getAllInstances().find((i) => i.name === instanceName);
    if (!instance) throw new Error("Instance not found");
    if (this.managers.has(instanceName)) throw new Error("Instance already running");

    const forwards = toForwardConfigs(instanceName);
    const manager = new ProxyManager(
      instanceName,
      instance.port,
      instance.headers ?? null,
      instance.hooks ?? null,
    );

    // 转发日志到已注册的回调
    manager.onLog((log) => {
      this.logCallbacks.forEach((cb) => {
        try {
          cb(log);
        } catch (error) {
          this.log.error("[ProxyInstancesManager] Error in log callback:", error as Error);
        }
      });
    });

    // 尝试启动，端口被占用时清理后重试
    try {
      await manager.start(forwards);
      this.managers.set(instanceName, manager);
      console.log(
        `[ProxyInstancesManager] Instance ${instance.name} started successfully on port ${instance.port}`,
      );
      this.emitStatusChange(instanceName);
    } catch (error) {
      if (isPortInUseError(error)) {
        await this.retryStartAfterPortCleanup(manager, instance, forwards);
      } else {
        console.error(`[ProxyInstancesManager] Failed to start instance ${instance.name}:`, error);
        throw error;
      }
    }
  }

  /**
   * 清理端口后重试启动
   */
  private async retryStartAfterPortCleanup(
    manager: ProxyManager,
    instance: { name: string; port: number },
    forwards: ForwardConfig[],
  ): Promise<void> {
    this.log.info(`[ProxyInstancesManager] Port ${instance.port} in use, cleaning up...`);
    await killPort(instance.port);
    await new Promise((resolve) => setTimeout(resolve, PORT_CLEANUP_DELAY_MS));

    try {
      await manager.start(forwards);
      this.managers.set(instance.name, manager);
      console.log(
        `[ProxyInstancesManager] Instance ${instance.name} started successfully on port ${instance.port} (after cleanup)`,
      );
      this.emitStatusChange(instance.name);
    } catch (retryError) {
      console.error(
        `[ProxyInstancesManager] Failed to start instance ${instance.name} after cleanup:`,
        retryError,
      );
      throw retryError;
    }
  }

  async stopInstance(instanceName: string): Promise<void> {
    const manager = this.managers.get(instanceName);
    if (!manager) throw new Error("Instance not running");
    await manager.stop();
    this.managers.delete(instanceName);
    console.log(`[ProxyInstancesManager] Instance ${instanceName} stopped successfully`);
    this.emitStatusChange(instanceName);
  }

  /**
   * 重载实例配置
   * 如果实例未运行则启动，否则热更新配置
   */
  async reloadInstance(instanceName: string): Promise<void> {
    const instance = getAllInstances().find((i) => i.name === instanceName);
    if (!instance) throw new Error("Instance not found");

    const manager = this.managers.get(instanceName);
    if (!manager) {
      await this.startInstance(instanceName);
      return;
    }

    const forwards = toForwardConfigs(instanceName);
    await manager.reload(forwards, instance.headers ?? null, instance.hooks ?? null);

    // 配置重载后广播同步状态
    await this.emitConfigChange(instanceName);
  }

  /** 中断指定实例中的请求 */
  async abortRequest(instanceName: string, dbRecordId: number): Promise<boolean> {
    const manager = this.managers.get(instanceName);
    if (!manager) return false;
    return manager.abortRequest(dbRecordId);
  }

  /** 获取实例当前配置（从 worker 获取） */
  async getInstanceWorkerConfig(instanceName: string): Promise<InstanceRuntimeConfig | null> {
    const manager = this.managers.get(instanceName);
    if (!manager) return null;
    return manager.getWorkerConfig();
  }

  /** 检查实例配置是否同步 */
  async checkInstanceConfigSync(instanceName: string): Promise<boolean> {
    const manager = this.managers.get(instanceName);
    if (!manager) return true; // 未运行的实例视为同步
    return manager.checkConfigSync();
  }

  /** 检查实例配置是否同步（返回详细信息） */
  async checkInstanceConfigSyncDetailed(instanceName: string): Promise<{
    synced: boolean;
    workerConfig: unknown;
    fileConfig: unknown;
  }> {
    const manager = this.managers.get(instanceName);
    if (!manager) {
      return { synced: true, workerConfig: null, fileConfig: null };
    }
    return manager.checkConfigSyncDetailed();
  }

  /** 获取实例期望的配置 */
  getInstanceExpectedConfig(instanceName: string): InstanceRuntimeConfig | null {
    const manager = this.managers.get(instanceName);
    if (!manager) return null;
    return manager.getExpectedConfig();
  }

  getInstanceStatus(instanceName: string): ProxyStatus {
    const manager = this.managers.get(instanceName);
    if (!manager) {
      const instance = getAllInstances().find((i) => i.name === instanceName);
      return { running: false, port: instance?.port ?? 0 };
    }
    return manager.getStatus();
  }

  getAllStatuses(): Map<string, ProxyStatus> {
    const statuses = new Map<string, ProxyStatus>();
    const instances = getAllInstances();
    for (const instance of instances) {
      statuses.set(instance.name, this.getInstanceStatus(instance.name));
    }
    return statuses;
  }

  getRunningInstanceNames(): string[] {
    return Array.from(this.managers.keys());
  }

  onLog(callback: LogCallback): () => void {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }

  async autoStartEnabledInstances(): Promise<void> {
    const enabledInstances = getAllInstances().filter((inst) => inst.enabled);
    if (enabledInstances.length === 0) {
      this.log.info("[ProxyInstancesManager] No enabled instances to auto-start");
      return;
    }
    console.log(
      `\n[ProxyInstancesManager] Auto-starting ${enabledInstances.length} enabled instance(s)...`,
    );
    for (const instance of enabledInstances) {
      try {
        await this.startInstance(instance.name);
        console.log(
          `[ProxyInstancesManager] Instance ${instance.name} (port ${instance.port}) started`,
        );
      } catch (error) {
        console.error(`[ProxyInstancesManager] Instance ${instance.name} failed to start:`, error);
      }
    }
    console.log(`\n[ProxyInstancesManager] Auto-start completed\n`);
  }

  async stopAll(): Promise<void> {
    console.log(
      `\n[ProxyInstancesManager] Stopping all ${this.managers.size} running instance(s)...`,
    );
    const stopPromises = Array.from(this.managers.keys()).map(async (name) => {
      try {
        await this.stopInstance(name);
      } catch (error) {
        console.error(`[ProxyInstancesManager] Failed to stop instance ${name}:`, error);
      }
    });
    await Promise.all(stopPromises);
    console.log("[ProxyInstancesManager] All instances stopped\n");
  }
}
