import { EventEmitter } from "node:events";
import type { InstanceRuntimeConfig } from "../../types/worker-messages";
import type { ForwardConfig } from "../../proxy-manager";

export type RuntimeChangeType = "init" | "reload" | "forward-update";

export interface RuntimeChangeEvent {
  type: RuntimeChangeType;
  config: InstanceRuntimeConfig;
  previousConfig?: InstanceRuntimeConfig;
  timestamp: number;
}

/**
 * 实例运行时配置 Store
 * 用于 Worker 内部管理当前实例的运行时配置
 * 不涉及文件操作，配置通过消息传递更新
 */
export class InstanceRuntimeStore extends EventEmitter {
  private config: InstanceRuntimeConfig | null = null;
  private version: number = 0;
  private destroyed: boolean = false;

  constructor() {
    super();
  }

  /** 获取当前配置 */
  getConfig(): InstanceRuntimeConfig | null {
    return this.config ? this.cloneConfig(this.config) : null;
  }

  /** 获取版本号 */
  getVersion(): number {
    return this.version;
  }

  /** 是否已初始化 */
  isInitialized(): boolean {
    return this.config !== null;
  }

  /** 是否已销毁 */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 初始化配置 */
  init(config: InstanceRuntimeConfig): void {
    if (this.destroyed) return;

    const previousConfig = this.config ? this.cloneConfig(this.config) : undefined;
    this.config = this.cloneConfig(config);
    this.version++;

    const event: RuntimeChangeEvent = {
      type: "init",
      config: this.cloneConfig(config),
      previousConfig,
      timestamp: Date.now(),
    };

    this.emit("change", event);
    this.emit("init", event);
  }

  /** 重载配置 */
  reload(config: InstanceRuntimeConfig): void {
    if (this.destroyed) return;

    const previousConfig = this.config ? this.cloneConfig(this.config) : undefined;
    this.config = this.cloneConfig(config);
    this.version++;

    const event: RuntimeChangeEvent = {
      type: "reload",
      config: this.cloneConfig(config),
      previousConfig,
      timestamp: Date.now(),
    };

    this.emit("change", event);
    this.emit("reload", event);
  }

  /** 获取所有转发规则 */
  getForwards(): ForwardConfig[] {
    return this.config?.forwards ?? [];
  }

  /** 获取启用的转发规则 */
  getEnabledForwards(): ForwardConfig[] {
    return this.getForwards().filter((f) => f.enabled);
  }

  /** 获取实例名称 */
  getInstanceName(): string | null {
    return this.config?.name ?? null;
  }

  /** 获取实例级 headers */
  getHeaders(): Record<string, string> | null {
    return this.config?.headers ?? null;
  }

  /** 获取实例级 hooks */
  getHooks() {
    return this.config?.hooks ?? null;
  }

  /** 比较配置是否相等 */
  isConfigEqual(other: InstanceRuntimeConfig): boolean {
    if (!this.config) return false;
    return JSON.stringify(this.config) === JSON.stringify(other);
  }

  /** 销毁 Store */
  destroy(): void {
    this.destroyed = true;
    this.config = null;
    this.removeAllListeners();
  }

  /** 深拷贝配置 */
  private cloneConfig(config: InstanceRuntimeConfig): InstanceRuntimeConfig {
    return JSON.parse(JSON.stringify(config));
  }
}
