import * as path from "node:path";
import * as fs from "node:fs";
import { createLogger, type Logger } from "./lib/logger";
import type { HooksConfig } from "./types/proxy";
import type { WorkerMessage, WorkerResponse, InstanceRuntimeConfig } from "./types/worker-messages";
import { getInstanceByName } from "./lib/config-store";
import { getInstanceConfigPath, getTempConfigDir, getDataDir } from "./lib/runtime-paths";
import { sleep } from "bun";

// 使用 with { type: "file" } 导入 Worker 路径
// - 开发模式：直接执行 TS 文件
// - 打包模式：build 脚本会临时修改此路径指向预编译的 JS 文件
// // @ts-expect-error TypeScript 不支持 `with { type: "file" }` 语法，但 Bun 支持
// import proxyServerPath from "../proxy-server.ts" with { type: "file" };

/** Worker 停止超时时间（毫秒） */
const WORKER_STOP_TIMEOUT_MS = 3000;
/** 健康检查间隔（毫秒） */
const HEALTH_CHECK_INTERVAL_MS = 10000;
/** 健康检查失败阈值（毫秒） */
const HEALTH_CHECK_FAILURE_THRESHOLD_MS = 15000;
/** 等待响应超时（毫秒） */
const RESPONSE_TIMEOUT_MS = 5000;

/** 代理实例状态 */
export interface ProxyStatus {
  /** 是否正在运行 */
  running: boolean;
  /** Worker 线程 ID */
  pid?: number;
  /** 配置端口 */
  port: number;
  /** 实际监听端口 */
  listeningPort?: number;
  /** 运行时间（毫秒） */
  uptime?: number;
  /** 配置是否同步 */
  configSynced?: boolean;
}

/** 代理日志消息 */
export interface ProxyLogMessage {
  /** 实例名称 */
  instanceName: string;
  /** 日志类型 */
  type: "stdout" | "stderr";
  /** 日志内容 */
  message: string;
  /** 时间戳 */
  timestamp: number;
}

type LogCallback = (log: ProxyLogMessage) => void;

/** 转发规则配置 */
export interface ForwardConfig {
  name: string;
  enabled: boolean;
  target: string;
  description?: string | null;
  path?: string | null;
  methods?: string[];
  headers?: Record<string, string> | null;
  hooks?: HooksConfig | null;
}

/**
 * 代理实例管理器
 * 负责管理单个代理实例的生命周期，包括启动、停止、热更新配置等
 *
 * 统一使用 Worker 模式运行代理服务器：
 * - 开发模式：直接加载 TypeScript 文件
 * - 打包模式：从内嵌的预编译 JS 代码创建 Worker
 */
export class ProxyManager {
  static #WorkerIdAcc = 1;
  static #WorkerId = new WeakMap<Worker, number>();
  static #getWorkerId(worker: Worker) {
    let id = ProxyManager.#WorkerId.get(worker);
    if (!id) {
      id = this.#WorkerIdAcc++;
      ProxyManager.#WorkerId.set(worker, id);
    }
    return id;
  }
  private worker: Worker | null = null;
  private readonly instanceName: string;
  private readonly port: number;
  private instanceHeaders: Record<string, string> | null;
  private instanceHooks: HooksConfig | null = null;
  private startTime: number | null = null;
  private readonly logCallbacks: Set<LogCallback> = new Set();
  private configPath: string | undefined;
  private readonly log: Logger;
  private currentForwards: ForwardConfig[] = [];
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private lastPongTime: number = 0;

  constructor(
    instanceName: string,
    port: number,
    instanceHeaders: Record<string, string> | null,
    instanceHooks: HooksConfig | null = null,
  ) {
    this.instanceName = instanceName;
    this.port = port;
    this.instanceHeaders = instanceHeaders;
    this.instanceHooks = instanceHooks;
    this.log = createLogger(`proxy:manager:${instanceName}`);
  }

  /** 检查是否正在运行 */
  private isRunning(): boolean {
    return this.worker !== null;
  }

  async start(forwards?: ForwardConfig[]): Promise<void> {
    if (this.isRunning()) throw new Error("Proxy is already running");

    this.currentForwards = forwards ?? [];

    // 统一使用 Worker 模式
    await this.startWorker(forwards);
  }

  /** Worker 模式启动 */
  private async startWorker(forwards?: ForwardConfig[]): Promise<void> {
    let configPath: string | undefined;

    if (forwards && forwards.length > 0) {
      configPath = this.writeConfigFile(forwards);
    }

    const argv = ["-p", String(this.port), "-i", this.instanceName];
    if (configPath) argv.push("-c", configPath);

    this.worker = new Worker(new URL("./proxy-server.js", import.meta.url).href);

    this.configPath = configPath;
    this.startTime = Date.now();

    this.worker.addEventListener("message", (event) => {
      const msg = event.data as WorkerResponse;

      // 处理 pong 响应，更新心跳时间
      if (msg?.type === "pong") {
        this.lastPongTime = Date.now();
        // pong 响应同时通过 sendMessage 的 Promise 处理
        return;
      }

      // 处理配置相关响应
      if (msg?.type === "reload-result" || msg?.type === "config" || msg?.type === "init-result") {
        // 这些响应通过 sendMessage 的 Promise 处理
        return;
      }

      // 处理日志消息
      if (msg?.type === "log") {
        const logMsg = msg as {
          type: "log";
          level: string;
          message: string;
          timestamp: number;
        };
        const logMessage: ProxyLogMessage = {
          instanceName: this.instanceName,
          type: logMsg.level === "error" || logMsg.level === "warn" ? "stderr" : "stdout",
          message: logMsg.message,
          timestamp: logMsg.timestamp ?? Date.now(),
        };
        this.logCallbacks.forEach((cb) => {
          try {
            cb(logMessage);
          } catch (error) {
            this.log.error("[ProxyManager] Error in log callback:", error as Error);
          }
        });
        return;
      }

      if (msg?.type === "server-error") {
        this.log.error(`[ProxyManager] Worker server error: ${msg.error} code=${msg.code ?? ""}`);
        // 服务器错误也应该触发 Worker 清理
        this.handleWorkerDeath();
      }
    });

    this.worker.addEventListener("error", (error) => {
      console.error(`[ProxyManager] Worker error (${this.instanceName}):`, error);
      this.handleWorkerDeath();
    });

    this.worker.addEventListener("close", (event) => {
      this.log.warn(`[ProxyManager] Worker for ${this.instanceName} exited`, event);
      this.handleWorkerDeath();
    });
    await this.waitForResponse("env-ready", RESPONSE_TIMEOUT_MS);

    this.worker.postMessage({ type: "pre-init", argv });

    // 启动阶段快速捕获端口占用等致命错误
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2500);
      const handler = (event: MessageEvent) => {
        const msg = event.data as WorkerResponse;
        if (msg?.type === "server-error") {
          clearTimeout(timer);
          this.worker?.removeEventListener("message", handler);
          this.worker?.terminate();
          this.worker = null;
          reject(
            new Error(`Worker failed to listen on port ${msg.port ?? this.port}: ${msg.error}`),
          );
        }
      };
      this.worker?.addEventListener("message", handler);
    });

    // 发送 init 消息初始化 Worker 中的数据库
    const initMessage: WorkerMessage = { type: "init", dataDir: getDataDir() };
    this.worker!.postMessage(initMessage);
    const initResponse = await this.waitForResponse("init-result", RESPONSE_TIMEOUT_MS);
    if (initResponse.type === "init-result" && !initResponse.success) {
      throw new Error(
        `Worker database init failed: ${(initResponse as any).error || "Unknown error"}`,
      );
    }

    // 启动健康检查
    this.startHealthCheck();

    console.log(`[ProxyManager] Started proxy instance ${this.instanceName} on port ${this.port}`);
  }

  /**
   * 停止代理实例
   * 发送 shutdown 消息让 Worker 优雅关闭，超时后强制终止
   */
  async stop(): Promise<void> {
    if (!this.isRunning()) throw new Error("Proxy is not running");

    this.stopHealthCheck();

    const workerRef = this.worker!;

    // 先清理状态，避免 handleWorkerDeath 的竞态条件
    this.worker = null;
    this.startTime = null;
    this.lastPongTime = 0;

    // 等待 Worker 退出，超时后强制终止
    await this.waitForWorkerExit(workerRef);

    // 清理临时配置文件
    this.cleanupConfigFile();

    // 短暂等待确保端口释放
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log(`[ProxyManager] Proxy instance ${this.instanceName} stopped`);
  }

  /**
   * 等待 Worker 退出
   * 先发送 shutdown 消息让 Worker 优雅关闭，超时后强制终止
   */
  private waitForWorkerExit(workerRef: Worker): Promise<void> {
    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.log.warn(
          `[ProxyManager] Worker exit timeout after ${WORKER_STOP_TIMEOUT_MS}ms, force terminating...`,
        );
        workerRef.terminate();
        resolve();
      }, WORKER_STOP_TIMEOUT_MS);

      workerRef.addEventListener("close", () => {
        clearTimeout(timeoutId);
        resolve();
      });

      // 发送关闭消息让 Worker 优雅关闭 server
      try {
        workerRef.postMessage({ type: "shutdown" } satisfies WorkerMessage);
      } catch {
        // Worker 可能已经退出，忽略错误
      }
    });
  }

  /** 清理临时配置文件 */
  private cleanupConfigFile(): void {
    const configFilePath = getInstanceConfigPath(this.instanceName);
    try {
      fs.unlinkSync(configFilePath);
      this.log.debug(`[ProxyManager] Config file removed: ${configFilePath}`);
    } catch {
      // 文件不存在时忽略
    }
    this.configPath = undefined;
  }

  /**
   * 热更新配置（不重启 worker）
   * @param forwards 新的转发规则列表
   * @param headers 新的实例级别请求头
   * @param hooks 新的钩子配置
   */
  async reload(
    forwards?: ForwardConfig[],
    headers?: Record<string, string> | null,
    hooks?: HooksConfig | null,
  ): Promise<void> {
    if (!this.isRunning()) throw new Error("Proxy is not running");

    const newForwards = forwards ?? this.currentForwards;
    const newHeaders = headers !== undefined ? headers : this.instanceHeaders;
    const newHooks = hooks !== undefined ? hooks : this.instanceHooks;

    const config: InstanceRuntimeConfig = {
      name: this.instanceName,
      headers: newHeaders,
      hooks: newHooks,
      forwards: newForwards,
    };

    const message: WorkerMessage = { type: "reload", config };
    this.worker!.postMessage(message);

    const response = await this.waitForResponse("reload-result", RESPONSE_TIMEOUT_MS);
    if (response.type === "reload-result" && !response.success) {
      throw new Error(response.error || "Reload failed");
    }

    // 更新本地状态
    this.currentForwards = newForwards;
    this.instanceHeaders = newHeaders;
    this.instanceHooks = newHooks;

    this.log.info(
      `[ProxyManager] Config reloaded for ${this.instanceName}: ${newForwards.length} forwards`,
    );
  }

  /** 获取当前运行时配置 */
  async getWorkerConfig(): Promise<InstanceRuntimeConfig | null> {
    if (!this.worker) return null;

    const message: WorkerMessage = { type: "get-config" };
    this.worker.postMessage(message);

    const response = await this.waitForResponse("config", RESPONSE_TIMEOUT_MS);
    if (response.type === "config") {
      return response.config;
    }
    return null;
  }

  /**
   * 中断指定请求
   * @param dbRecordId 数据库记录 ID
   * @returns 是否成功中断
   */
  async abortRequest(dbRecordId: number): Promise<boolean> {
    if (!this.worker) return false;

    const message: WorkerMessage = { type: "abort-request", dbRecordId };
    this.worker.postMessage(message);

    try {
      const response = await this.waitForAbortResult(dbRecordId, RESPONSE_TIMEOUT_MS);
      return response.success;
    } catch {
      return false;
    }
  }

  /** 从 proxy-config.json 构建该实例的运行时配置 */
  private buildConfigFromProxyConfig(): InstanceRuntimeConfig | null {
    const instance = getInstanceByName(this.instanceName);
    if (!instance) return null;

    return {
      name: this.instanceName,
      headers: instance.headers,
      hooks: instance.hooks ?? null,
      forwards: instance.forwards.map((f) => ({
        name: f.name,
        target: f.target,
        enabled: f.enabled,
        description: f.description,
        path: f.path,
        methods: f.methods,
        headers: f.headers,
        hooks: f.hooks,
      })),
    };
  }

  /** 检查配置是否同步（比较 instance 配置文件和 worker 内部配置） */
  async checkConfigSync(): Promise<boolean> {
    const workerConfig = await this.getWorkerConfig();
    if (!workerConfig) return false;

    // 从 proxy-config.json 获取最新配置
    const proxyFileConfig = this.buildConfigFromProxyConfig();
    if (!proxyFileConfig) return false;

    return JSON.stringify(workerConfig) === JSON.stringify(proxyFileConfig);
  }

  /** 检查配置是否同步（返回详细信息用于调试） */
  async checkConfigSyncDetailed(): Promise<{
    synced: boolean;
    workerConfig: InstanceRuntimeConfig | null;
    fileConfig: InstanceRuntimeConfig | null;
  }> {
    const workerConfig = await this.getWorkerConfig();
    // 从 proxy-config.json 获取最新配置（这是唯一数据源）
    const fileConfig = this.buildConfigFromProxyConfig();

    const synced =
      workerConfig && fileConfig
        ? JSON.stringify(workerConfig) === JSON.stringify(fileConfig)
        : false;

    return { synced, workerConfig, fileConfig };
  }

  /** 等待特定类型的响应 */
  private waitForResponse(expectedType: string, timeoutMs: number): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.worker?.removeEventListener("message", handler);
        reject(new Error(`Timeout waiting for ${expectedType}`));
      }, timeoutMs);

      const handler = (event: MessageEvent) => {
        const msg = event.data as WorkerResponse;
        if (msg?.type === expectedType) {
          clearTimeout(timeout);
          this.worker?.removeEventListener("message", handler);
          resolve(msg);
        }
      };

      this.worker?.addEventListener("message", handler);
    });
  }

  private waitForAbortResult(
    dbRecordId: number,
    timeoutMs: number,
  ): Promise<Extract<WorkerResponse, { type: "abort-result" }>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.worker?.removeEventListener("message", handler);
        reject(new Error(`Timeout waiting for abort-result for ${dbRecordId}`));
      }, timeoutMs);

      const handler = (event: MessageEvent) => {
        const msg = event.data as WorkerResponse;
        if (msg?.type === "abort-result" && msg.dbRecordId === dbRecordId) {
          clearTimeout(timeout);
          this.worker?.removeEventListener("message", handler);
          resolve(msg);
        }
      };

      this.worker?.addEventListener("message", handler);
    });
  }

  getStatus(): ProxyStatus {
    const running = this.isRunning();
    return {
      running,
      pid: this.worker ? ProxyManager.#getWorkerId(this.worker) : undefined,
      port: this.port,
      listeningPort: running ? this.port : undefined,
      uptime: this.startTime ? Date.now() - this.startTime : undefined,
    };
  }

  /** 获取当前期望的配置 */
  getExpectedConfig(): InstanceRuntimeConfig {
    return {
      name: this.instanceName,
      headers: this.instanceHeaders,
      hooks: this.instanceHooks,
      forwards: this.currentForwards,
    };
  }

  /** 更新期望的配置（用于外部更新后同步） */
  updateExpectedConfig(
    forwards: ForwardConfig[],
    headers?: Record<string, string> | null,
    hooks?: HooksConfig | null,
  ): void {
    this.currentForwards = forwards;
    if (headers !== undefined) this.instanceHeaders = headers;
    if (hooks !== undefined) this.instanceHooks = hooks;
  }

  onLog(callback: LogCallback): () => void {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }

  /** 写入 instance 配置文件（单一数据源） */
  private writeConfigFile(forwards: ForwardConfig[]): string {
    const configDir = getTempConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = getInstanceConfigPath(this.instanceName);

    // 写入 InstanceRuntimeConfig 格式，不是 ProxyConfigFile 格式
    const instanceConfig: InstanceRuntimeConfig = {
      name: this.instanceName,
      headers: this.instanceHeaders,
      hooks: this.instanceHooks,
      forwards,
    };

    fs.writeFileSync(configPath, JSON.stringify(instanceConfig, null, 2), "utf-8");
    this.log.debug(`[ProxyManager] Instance config written to ${configPath}`);
    return configPath;
  }

  /** 获取 instance 配置文件路径 */
  getConfigPath(): string {
    return getInstanceConfigPath(this.instanceName);
  }

  /** 从 instance 配置文件读取配置 */
  readInstanceConfigFile(): InstanceRuntimeConfig | null {
    const configPath = this.getConfigPath();
    try {
      if (!fs.existsSync(configPath)) return null;
      const content = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(content) as InstanceRuntimeConfig;
    } catch (error) {
      this.log.error(`[ProxyManager] Failed to read instance config: ${error}`);
      return null;
    }
  }

  /** 启动健康检查定时器 */
  private startHealthCheck(): void {
    this.lastPongTime = Date.now();

    this.healthCheckTimer = setInterval(async () => {
      if (!this.worker) {
        this.stopHealthCheck();
        return;
      }

      const now = Date.now();
      // 检查上次 pong 是否超过阈值（允许一次失败）
      if (this.lastPongTime > 0 && now - this.lastPongTime > HEALTH_CHECK_FAILURE_THRESHOLD_MS) {
        this.log.warn(
          `Health check failed for ${this.instanceName}, no pong in ${HEALTH_CHECK_FAILURE_THRESHOLD_MS}ms`,
        );
        this.handleWorkerDeath();
        return;
      }

      try {
        const message: WorkerMessage = { type: "ping" };
        this.worker.postMessage(message);
        await this.waitForResponse("pong", RESPONSE_TIMEOUT_MS);
        // lastPongTime 已在 message handler 中更新
      } catch (error) {
        this.log.warn(`Ping failed for ${this.instanceName}: ${error}`);
        // 不立即清理，等待下次检查
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /** 停止健康检查定时器 */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** 处理 Worker 异常退出（清理资源） */
  private handleWorkerDeath(): void {
    this.stopHealthCheck();
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // 忽略终止错误
      }
      this.worker = null;
      this.startTime = null;
      this.lastPongTime = 0;
    }
  }
}
