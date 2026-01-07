/**
 * Hooks 执行器
 *
 * 使用进程模式启动插件，通过 HTTP 代理链式调用
 */

import * as http from "node:http";
import { spawn, type Subprocess } from "bun";
import { createHash } from "node:crypto";
import type { HookConfig, HooksConfig } from "../types/proxy";

const CALLBACK_TIMEOUT_MS = 15000;

function computeConfigHash(config: HookConfig, nextHopUrl: string | undefined): string {
  const data = JSON.stringify({ config, nextHopUrl });
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function normalizeHooksConfig(hooks: HooksConfig | null | undefined): HookConfig[] {
  if (!hooks) return [];
  const list = Array.isArray(hooks) ? hooks : [hooks];
  return list.filter((hook) => hook.disabled !== true);
}

interface CallbackServer {
  url: string;
  waitForUrl(): Promise<string>;
  close(): void;
}

function createCallbackServer(): CallbackServer {
  let resolveUrl: (url: string) => void;
  let rejectUrl: (err: Error) => void;
  const urlPromise = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        res.writeHead(200);
        res.end("OK");
        resolveUrl!(body.trim());
      });
    } else {
      res.writeHead(405);
      res.end();
    }
  });

  server.listen(0, "127.0.0.1");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const timeout = setTimeout(() => {
    rejectUrl!(new Error(`Callback timeout after ${CALLBACK_TIMEOUT_MS}ms`));
    server.close();
  }, CALLBACK_TIMEOUT_MS);

  return {
    url,
    async waitForUrl() {
      const result = await urlPromise;
      clearTimeout(timeout);
      server.close();
      return result;
    },
    close() {
      clearTimeout(timeout);
      server.close();
    },
  };
}

class PluginProcess {
  readonly config: HookConfig;
  readonly hash: string;
  private _url: string | null = null;
  private refCount = 0;
  private process: Subprocess | null = null;
  private nextHopUrl: string | undefined;

  constructor(config: HookConfig, nextHopUrl: string | undefined) {
    this.config = config;
    this.nextHopUrl = nextHopUrl;
    this.hash = computeConfigHash(config, nextHopUrl);
  }

  get url(): string {
    if (!this._url) throw new Error("Plugin not started");
    return this._url;
  }

  get pluginName(): string {
    if (this.config.config && typeof this.config.config === "object" && "name" in this.config.config) {
      return String((this.config.config as any).name);
    }
    const args = this.config.args ?? [];
    for (const arg of args) {
      if (arg.startsWith("@jixo/")) return arg.replace("@jixo/", "");
      if (arg.includes("proxy-plugin-")) {
        return arg.split("/").pop() ?? arg;
      }
    }
    return this.config.command;
  }

  async start(): Promise<void> {
    const callback = createCallbackServer();

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      __CALLBACK_URL__: callback.url,
    };

    if (this.config.config) {
      env.PLUGIN_CONFIG = JSON.stringify(this.config.config);
    }

    if (this.nextHopUrl) {
      env.HTTP_PROXY = this.nextHopUrl;
      env.HTTPS_PROXY = this.nextHopUrl;
    }

    const args = this.config.args ?? [];
    this.process = spawn([this.config.command, ...args], {
      cwd: this.config.cwd,
      env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });

    try {
      this._url = await callback.waitForUrl();
      console.log(`[HooksPool:${this.hash}] Started: ${this.config.command} ${args.join(" ")} -> ${this._url}`);
    } catch (error) {
      this.process.kill();
      this.process = null;
      throw error;
    }
  }

  addRef(): void {
    this.refCount++;
  }

  release(): boolean {
    this.refCount--;
    return this.refCount <= 0;
  }

  kill(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      console.log(`[HooksPool:${this.hash}] Stopped`);
    }
  }
}

class HooksPool {
  private pool = new Map<string, PluginProcess>();

  async acquire(config: HookConfig, nextHopUrl: string | undefined): Promise<PluginProcess> {
    const hash = computeConfigHash(config, nextHopUrl);

    let proc = this.pool.get(hash);
    if (!proc) {
      proc = new PluginProcess(config, nextHopUrl);
      await proc.start();
      this.pool.set(hash, proc);
    }
    proc.addRef();
    return proc;
  }

  async release(proc: PluginProcess): Promise<void> {
    if (proc.release()) {
      proc.kill();
      this.pool.delete(proc.hash);
    }
  }

  async stopAll(): Promise<void> {
    for (const proc of this.pool.values()) {
      proc.kill();
    }
    this.pool.clear();
  }

  get size(): number {
    return this.pool.size;
  }
}

const globalHooksPool = new HooksPool();

export interface PrecheckSummary {
  needsBuffer: boolean;
  activePlugins: string[];
  canPassthrough: boolean;
}

export class HooksExecutor {
  private instanceName: string;
  private instanceHooksConfig: HookConfig[];
  private forwardHooksConfig: HookConfig[] = [];
  private pluginProcesses: PluginProcess[] = [];
  private _firstPluginUrl: string | null = null;

  constructor(
    instanceName: string,
    instanceHooks: HooksConfig | null | undefined,
  ) {
    this.instanceName = instanceName;
    this.instanceHooksConfig = normalizeHooksConfig(instanceHooks);
  }

  async start(): Promise<void> {
    await this.rebuildHopChain();
  }

  async stop(): Promise<void> {
    for (const proc of this.pluginProcesses) {
      await globalHooksPool.release(proc);
    }
    this.pluginProcesses = [];
    this._firstPluginUrl = null;
  }

  async setForwardHooks(_forwardName: string, hooks: HooksConfig | null | undefined): Promise<void> {
    const newConfigs = normalizeHooksConfig(hooks);
    const oldConfigsJson = JSON.stringify(this.forwardHooksConfig);
    const newConfigsJson = JSON.stringify(newConfigs);

    if (oldConfigsJson !== newConfigsJson) {
      this.forwardHooksConfig = newConfigs;
      await this.rebuildHopChain();
    }
  }

  private async rebuildHopChain(): Promise<void> {
    for (const proc of this.pluginProcesses) {
      await globalHooksPool.release(proc);
    }
    this.pluginProcesses = [];

    const allConfigs = [...this.instanceHooksConfig, ...this.forwardHooksConfig];
    if (allConfigs.length === 0) {
      this._firstPluginUrl = null;
      return;
    }

    let nextHop = process.env.HTTP_PROXY || process.env.http_proxy;

    for (let i = allConfigs.length - 1; i >= 0; i--) {
      const config = allConfigs[i]!;
      const proc = await globalHooksPool.acquire(config, nextHop);
      this.pluginProcesses.unshift(proc);
      nextHop = proc.url;
    }

    this._firstPluginUrl = this.pluginProcesses[0]?.url ?? null;
    console.log(`[HooksExecutor:${this.instanceName}] Hop chain: ${this.pluginProcesses.map((p) => p.pluginName).join(" -> ")} -> upstream`);
  }

  getFirstPluginUrl(): string | null {
    return this._firstPluginUrl;
  }

  get hasHooks(): boolean {
    return this.pluginProcesses.length > 0;
  }

  get hasRequestHooks(): boolean {
    return this.hasHooks;
  }

  get hasResponseHooks(): boolean {
    return this.hasHooks;
  }

  async precheckRequest(): Promise<PrecheckSummary> {
    return {
      needsBuffer: false,
      activePlugins: this.pluginProcesses.map((p) => p.pluginName),
      canPassthrough: true,
    };
  }

  async precheckResponse(): Promise<PrecheckSummary> {
    return {
      needsBuffer: false,
      activePlugins: this.pluginProcesses.map((p) => p.pluginName),
      canPassthrough: true,
    };
  }
}

export function getHooksPoolStats(): { size: number } {
  return { size: globalHooksPool.size };
}

export async function stopAllHooks(): Promise<void> {
  await globalHooksPool.stopAll();
}
