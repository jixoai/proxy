import type { Subprocess } from "bun";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ProxyStatus {
  running: boolean;
  pid?: number;
  port: number;
  listeningPort?: number;
  uptime?: number;
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
}

export class ProxyManager {
  private process: Subprocess | null = null;
  private readonly instanceName: string;
  private readonly port: number;
  private readonly instanceHeaders: Record<string, string> | null;
  private startTime: number | null = null;
  private readonly logCallbacks: Set<LogCallback> = new Set();
  private configPath: string | undefined;

  constructor(
    instanceName: string,
    port: number,
    instanceHeaders: Record<string, string> | null,
  ) {
    this.instanceName = instanceName;
    this.port = port;
    this.instanceHeaders = instanceHeaders;
  }

  async start(forwards?: ForwardConfig[]): Promise<void> {
    if (this.process) {
      throw new Error("Proxy is already running");
    }

    const proxyServerPath = path.join(__dirname, "../proxy-server.ts");
    let configPath: string | undefined;

    if (forwards && forwards.length > 0) {
      configPath = this.writeConfigFile(forwards);
    }

    const args = [
      "bun",
      proxyServerPath,
      "-p",
      String(this.port),
      "-i",
      this.instanceName,
    ];
    if (configPath) args.push("-c", configPath);

    this.process = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: path.join(__dirname, ".."),
    });
    this.configPath = configPath;

    this.startTime = Date.now();

    if (this.process.stdout) {
      this.streamLogs(
        this.process.stdout as ReadableStream<Uint8Array>,
        "stdout",
      );
    }
    if (this.process.stderr) {
      this.streamLogs(
        this.process.stderr as ReadableStream<Uint8Array>,
        "stderr",
      );
    }

    console.log(
      `[ProxyManager] Started proxy instance ${this.instanceName} on port ${this.port}, PID: ${this.process.pid}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.process) throw new Error("Proxy is not running");

    const pid = this.process.pid;
    if (!this.process.killed) {
      this.process.kill();
      const exitPromise = this.process.exited.catch(() => {});
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(resolve, 2000),
      );
      await Promise.race([exitPromise, timeoutPromise]);

      if (this.process && !this.process.killed) {
        console.log(`[ProxyManager] Force killing process ${pid}`);
        this.process.kill("SIGKILL");
        await this.process.exited.catch(() => {});
      }

      this.process = null;
      this.startTime = null;

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const configPath = path.join(
      __dirname,
      `../.tmp/instance-${this.instanceName}-config.json`,
    );
    try {
      fs.unlinkSync(configPath);
      console.log(`[ProxyManager] Config file removed: ${configPath}`);
    } catch {
      // ignore missing
    }
    this.configPath = undefined;

    console.log(`[ProxyManager] Proxy instance ${this.instanceName} stopped`);
  }

  async reload(forwards?: ForwardConfig[]): Promise<void> {
    if (!this.process) {
      throw new Error("Proxy is not running");
    }
    if (forwards && forwards.length > 0) {
      this.configPath = this.writeConfigFile(forwards);
    }
    if (!this.configPath) {
      console.warn(
        `[ProxyManager] No config path available for ${this.instanceName}, skipping reload`,
      );
      return;
    }
    console.log(`[ProxyManager] Reloading instance ${this.instanceName}`);
    this.process.kill("SIGUSR2");
  }

  getStatus(): ProxyStatus {
    return {
      running: this.process !== null,
      pid: this.process?.pid,
      port: this.port,
      listeningPort: this.process ? this.port : undefined,
      uptime: this.startTime ? Date.now() - this.startTime : undefined,
    };
  }

  onLog(callback: LogCallback): () => void {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }

  private async streamLogs(
    stream: ReadableStream<Uint8Array>,
    type: "stdout" | "stderr",
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split("\n").filter((line) => line.trim());
        for (const line of lines) {
          const logMessage: ProxyLogMessage = {
            instanceName: this.instanceName,
            type,
            message: line,
            timestamp: Date.now(),
          };
          this.logCallbacks.forEach((cb) => {
            try {
              cb(logMessage);
            } catch (error) {
              console.error("[ProxyManager] Error in log callback:", error);
            }
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private writeConfigFile(forwards: ForwardConfig[]): string {
    const configDir = path.join(__dirname, "../.tmp");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(
      configDir,
      `instance-${this.instanceName}-config.json`,
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          instanceHeaders: this.instanceHeaders,
          forwards,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`[ProxyManager] Config written to ${configPath}`);
    return configPath;
  }
}
