import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createLogger, type Logger } from "./logger";
import type { HooksConfig } from "../types/proxy";
import type {
  WorkerMessage,
  WorkerResponse,
  InstanceRuntimeConfig,
} from "../types/worker-messages";
import { getInstanceByName } from "./config-store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ProxyStatus {
  running: boolean;
  pid?: number;
  port: number;
  listeningPort?: number;
  uptime?: number;
  /** 配置是否同步 */
  configSynced?: boolean;
}

export interface ProxyLogMessage {
  instanceName: string;
  type: "stdout" | "stderr";
  message: string;
  timestamp: number;
}

type LogCallback = (log: ProxyLogMessage) => void;

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

export class ProxyManager {
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
  private pendingResponses = new Map<
    string,
    { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }
  >();
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

  async start(forwards?: ForwardConfig[]): Promise<void> {
    if (this.worker) throw new Error("Proxy is already running");

    const proxyServerPath = path.join(__dirname, "../proxy-server.ts");
    let configPath: string | undefined;

    this.currentForwards = forwards ?? [];

    if (forwards && forwards.length > 0) {
      configPath = this.writeConfigFile(forwards);
    }

    const argv = ["-p", String(this.port), "-i", this.instanceName];
    if (configPath) argv.push("-c", configPath);

    this.worker = new Worker(proxyServerPath, {
      argv,
    });
    this.configPath = configPath;
    this.startTime = Date.now();

    this.worker.on("message", (payload: unknown) => {
      const msg = payload as WorkerResponse;

      // 处理 pong 响应，更新心跳时间
      if (msg?.type === "pong") {
        this.lastPongTime = Date.now();
        // pong 响应同时通过 sendMessage 的 Promise 处理
        return;
      }

      // 处理配置相关响应
      if (msg?.type === "reload-result" || msg?.type === "config") {
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

    this.worker.on("error", (error) => {
      console.error(`[ProxyManager] Worker error (${this.instanceName}):`, error);
      this.handleWorkerDeath();
    });

    this.worker.on("exit", (code) => {
      if (code !== 0) {
        this.log.warn(`[ProxyManager] Worker for ${this.instanceName} exited with code ${code}`);
      }
      this.handleWorkerDeath();
    });

    // 启动阶段快速捕获端口占用等致命错误
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2500);
      const handler = (msg: WorkerResponse) => {
        if (msg?.type === "server-error") {
          clearTimeout(timer);
          this.worker?.off("message", handler);
          this.worker?.terminate().catch(() => {});
          this.worker = null;
          reject(
            new Error(`Worker failed to listen on port ${msg.port ?? this.port}: ${msg.error}`),
          );
        }
      };
      this.worker?.on("message", handler);
    });

    // 启动健康检查
    this.startHealthCheck();

    console.log(`[ProxyManager] Started proxy instance ${this.instanceName} on port ${this.port}`);
  }

  async stop(): Promise<void> {
    if (!this.worker) throw new Error("Proxy is not running");

    this.stopHealthCheck();
    await this.worker.terminate();
    this.worker = null;
    this.startTime = null;
    this.lastPongTime = 0;

    const configPath = path.join(__dirname, `../.tmp/instance-${this.instanceName}-config.json`);
    try {
      fs.unlinkSync(configPath);
      this.log.info(`[ProxyManager] Config file removed: ${configPath}`);
    } catch {
      // ignore missing
    }
    this.configPath = undefined;

    console.log(`[ProxyManager] Proxy instance ${this.instanceName} stopped`);
  }

  /** 热更新配置（不重启 worker） */
  async reload(
    forwards?: ForwardConfig[],
    headers?: Record<string, string> | null,
    hooks?: HooksConfig | null,
  ): Promise<void> {
    if (!this.worker) throw new Error("Proxy is not running");

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
    this.worker.postMessage(message);

    // 等待响应
    const response = await this.waitForResponse("reload-result", 5000);
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

  /** 获取 worker 当前配置 */
  async getWorkerConfig(): Promise<InstanceRuntimeConfig | null> {
    if (!this.worker) return null;

    const message: WorkerMessage = { type: "get-config" };
    this.worker.postMessage(message);

    const response = await this.waitForResponse("config", 5000);
    if (response.type === "config") {
      return response.config;
    }
    return null;
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
        this.worker?.removeListener("message", handler);
        reject(new Error(`Timeout waiting for ${expectedType}`));
      }, timeoutMs);

      const handler = (msg: WorkerResponse) => {
        if (msg?.type === expectedType) {
          clearTimeout(timeout);
          this.worker?.removeListener("message", handler);
          resolve(msg);
        }
      };

      this.worker?.on("message", handler);
    });
  }

  getStatus(): ProxyStatus {
    return {
      running: this.worker !== null,
      pid: this.worker?.threadId,
      port: this.port,
      listeningPort: this.worker ? this.port : undefined,
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
    const configDir = path.join(__dirname, "../.tmp");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, `instance-${this.instanceName}-config.json`);
    
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
  getInstanceConfigPath(): string {
    return path.join(__dirname, "../.tmp", `instance-${this.instanceName}-config.json`);
  }
  
  /** 从 instance 配置文件读取配置 */
  readInstanceConfigFile(): InstanceRuntimeConfig | null {
    const configPath = this.getInstanceConfigPath();
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
    // 初始化 lastPongTime
    this.lastPongTime = Date.now();

    this.healthCheckTimer = setInterval(async () => {
      if (!this.worker) {
        this.stopHealthCheck();
        return;
      }

      const now = Date.now();
      // 检查上次 pong 是否超过 15 秒（允许一次失败）
      if (this.lastPongTime > 0 && now - this.lastPongTime > 15000) {
        this.log.warn(`Health check failed for ${this.instanceName}, no pong in 15s`);
        this.handleWorkerDeath();
        return;
      }

      try {
        const message: WorkerMessage = { type: "ping" };
        this.worker.postMessage(message);

        // 等待 pong 响应（超时 5 秒）
        await this.waitForResponse("pong", 5000);
        // lastPongTime 已在 message handler 中更新
      } catch (error) {
        this.log.warn(`Ping failed for ${this.instanceName}: ${error}`);
        // 不立即清理，等待下次检查（15秒无响应后才清理）
      }
    }, 10000); // 每 10 秒检查一次
  }

  /** 停止健康检查定时器 */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** 处理 Worker 死亡（清理资源） */
  private handleWorkerDeath(): void {
    this.stopHealthCheck();
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (error) {
        // ignore termination errors
      }
      this.worker = null;
      this.startTime = null;
      this.lastPongTime = 0;
    }
  }
}
