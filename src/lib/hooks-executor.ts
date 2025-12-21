import { spawn, type Subprocess } from "bun";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import createDebug from "debug";
import type { HookConfig, HooksConfig, HookLayer } from "../types/proxy";

const debug = createDebug("proxy:hooks");

/** 私有 header：记录处理过该请求的插件列表 */
const HEADER_PLUGIN_PROCESSED = "-x-jixo-proxy-plugin-processed";

/** 从 HookConfig 提取插件名称 */
function getPluginName(config: HookConfig): string {
  // 优先使用 config 中的 name 字段
  if (config.config && typeof config.config === "object" && "name" in config.config) {
    return String(config.config.name);
  }
  // 其次从 args 中提取（如 bunx @jixo/proxy-plugin-droid -> proxy-plugin-droid）
  const args = config.args ?? [];
  for (const arg of args) {
    if (arg.startsWith("@jixo/")) {
      return arg.replace("@jixo/", "");
    }
    if (arg.includes("proxy-plugin-") || arg.includes("proxy-anthropic-")) {
      return arg.split("/").pop() ?? arg;
    }
  }
  // 最后使用 command
  return config.command;
}

/** 添加插件处理标记到 headers */
function addPluginProcessedHeader(
  headers: Record<string, string | string[]>,
  pluginName: string,
): Record<string, string | string[]> {
  const existing = headers[HEADER_PLUGIN_PROCESSED];
  const list = existing
    ? (Array.isArray(existing) ? existing.join(",") : existing).split(",")
    : [];
  if (!list.includes(pluginName)) {
    list.push(pluginName);
  }
  return {
    ...headers,
    [HEADER_PLUGIN_PROCESSED]: list.join(","),
  };
}

/** 规范化 hooks 配置 */
function normalizeHooksConfig(hooks: HooksConfig | null | undefined): HookConfig[] {
  if (!hooks) return [];
  return Array.isArray(hooks) ? hooks : [hooks];
}

export interface RequestHookParams {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  signal?: AbortSignal;
}

export interface RequestHookResult {
  /** 是否被跳过（插件返回 null） */
  skipped?: boolean;
  /** 是否修改了内容 */
  modified?: boolean;
  /** 短路请求，直接返回响应 */
  respondWith?: {
    statusCode: number;
    headers?: Record<string, string | string[]>;
    body?: Buffer;
  };
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer;
}

export interface ResponseHookParams {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  signal?: AbortSignal;
}

export interface ResponseHookResult {
  /** 是否被跳过（插件返回 null） */
  skipped?: boolean;
  /** 是否修改了内容 */
  modified?: boolean;
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer;
}

const HEADER_LENGTH_BYTES = 4;
const CALLBACK_TIMEOUT_MS = 15_000;

/** head-len (uint32be) + json(meta) + body */
function encodeEnvelope(meta: unknown, body: Uint8Array): Buffer {
  const metaBuffer = Buffer.from(JSON.stringify(meta ?? {}), "utf-8");
  const lenBuffer = Buffer.alloc(HEADER_LENGTH_BYTES);
  lenBuffer.writeUInt32BE(metaBuffer.length, 0);
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([lenBuffer, metaBuffer, bodyBuffer]);
}

function decodeEnvelope(buffer: Buffer): { meta: unknown; body: Buffer } {
  if (buffer.length < HEADER_LENGTH_BYTES) {
    throw new Error("Invalid hook response: missing head-len");
  }
  const headLen = buffer.readUInt32BE(0);
  if (buffer.length < HEADER_LENGTH_BYTES + headLen) {
    throw new Error("Invalid hook response: head-len mismatch");
  }
  const metaBuffer = buffer.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + headLen);
  const body = buffer.subarray(HEADER_LENGTH_BYTES + headLen);
  const metaJson = metaBuffer.toString("utf-8") || "{}";
  const meta = JSON.parse(metaJson);
  return { meta, body };
}

function normalizeHeaders(
  headers: unknown,
): Record<string, string | string[]> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string" || Array.isArray(value)) {
      result[key] = value as string | string[];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 生成配置的hashid */
function computeConfigHash(config: HookConfig): string {
  const entries = Object.entries(config).sort(([a], [b]) => a.localeCompare(b));
  const normalized = JSON.stringify(entries);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(normalized);
  return hasher.digest("hex").slice(0, 16);
}

class HookProcess {
  private process: Subprocess | null = null;
  private refCount = 0;
  private listenUrl: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private callbackServer: http.Server | null = null;
  private _pluginName: string;

  constructor(
    private config: HookConfig,
    readonly hashId: string,
  ) {
    this._pluginName = getPluginName(config);
  }

  get pluginName(): string {
    return this._pluginName;
  }

  addRef(): void {
    this.refCount++;
  }

  release(): boolean {
    this.refCount--;
    return this.refCount <= 0;
  }

  get isReady(): boolean {
    return this.listenUrl !== null;
  }

  private async createCallbackServer(): Promise<{
    url: string;
    waitForUrl: () => Promise<string>;
    close: () => Promise<void>;
  }> {
    let resolveUrl: (url: string) => void = () => {};
    let rejectUrl: (err: Error) => void = () => {};
    const listenUrlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });

    const server = http.createServer((req, res) => {
      debug(`[HookPool:${this.hashId}] Callback server received ${req.method} request`);
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        const payload = Buffer.concat(chunks).toString("utf-8").trim();
        debug(`[HookPool:${this.hashId}] Callback received payload: ${payload}`);
        if (!payload) {
          res.statusCode = 400;
          res.end("empty body");
          return;
        }
        if (!this.listenUrl) {
          resolveUrl(payload);
        }
        res.statusCode = 200;
        res.end("ok");
      });
      req.on("error", (err) => rejectUrl(err));
    });

    server.on("error", (err) => rejectUrl(err));

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/`;
    this.callbackServer = server;

    return {
      url,
      waitForUrl: () => listenUrlPromise,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
  }

  async start(): Promise<void> {
    if (this.process) return;
    if (this.config.type !== "http") {
      throw new Error(`Unsupported hook type: ${this.config.type}`);
    }

    const callback = await this.createCallbackServer();
    const args = [this.config.command, ...(this.config.args ?? [])];

    // 构建环境变量，包含插件配置
    const pluginEnv: Record<string, string | undefined> = {
      ...process.env,
      __CALLBACK_URL__: callback.url,
    };

    // 如果有插件配置，通过 PLUGIN_CONFIG 环境变量传递
    if (this.config.config) {
      pluginEnv.PLUGIN_CONFIG = JSON.stringify(this.config.config);
    }

    debug(`[HookPool:${this.hashId}] Starting: ${args.join(" ")} with callback ${callback.url}`);

    this.process = spawn(args, {
      cwd: this.config.cwd,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: pluginEnv,
    });

    // 监听进程退出
    this.process.exited.then((code) => {
      if (code !== 0 && code !== null) {
        console.error(`[HookPool:${this.hashId}] Process exited with code ${code}`);
      }
    });

    this.readyPromise = (async () => {
      try {
        const listenUrl = await Promise.race([
          callback.waitForUrl(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Hook ${this.hashId} callback timeout`)), CALLBACK_TIMEOUT_MS),
          ),
        ]);
        this.listenUrl = listenUrl;
        await callback.close().catch(() => undefined);
        debug(`[HookPool:${this.hashId}] Started: ${args.join(" ")} -> ${listenUrl}`);
      } catch (err) {
        await callback.close().catch(() => undefined);
        this.process?.kill();
        this.process = null;
        throw err;
      }
    })();

    await this.readyPromise;
  }

  private async ensureReady(): Promise<void> {
    if (!this.process) {
      await this.start();
      return;
    }
    if (this.readyPromise) {
      await this.readyPromise;
    }
    if (!this.listenUrl) {
      throw new Error(`Hook process not ready: ${this.hashId}`);
    }
  }

  private async postEnvelope(
    endpoint: string,
    meta: unknown,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ meta: unknown; body: Buffer }> {
    await this.ensureReady();
    if (!this.listenUrl) {
      throw new Error(`Hook process not ready: ${this.hashId}`);
    }

    const target = new URL(endpoint, this.listenUrl).toString();
    const payload = encodeEnvelope(meta, body);
    const payloadView = new Uint8Array(payload);
    const resp = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([payloadView]),
      signal,
    });

    if (!resp.ok) {
      throw new Error(`Hook ${this.hashId} ${endpoint} failed with status ${resp.status}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    return decodeEnvelope(buffer);
  }

  async rewriteRequest(params: RequestHookParams): Promise<RequestHookResult> {
    const { meta, body } = await this.postEnvelope(
      "hook-req-requestBody",
      {
        method: params.method,
        url: params.url,
        headers: params.headers,
        bodyLength: params.body.length,
      },
      params.body,
      params.signal,
    );

    const metaObj = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};

    // 检查是否是 respondWith - 短路请求
    if (metaObj.respondWith === true) {
      const headers = normalizeHeaders(metaObj.headers);
      return {
        respondWith: {
          statusCode: typeof metaObj.statusCode === "number" ? metaObj.statusCode : 200,
          headers,
          body,
        },
      };
    }

    // 检查是否被跳过（插件返回 null）
    if (metaObj.skipped === true) {
      return { skipped: true };
    }

    // 检查是否未修改
    if (metaObj.modified === false) {
      return { modified: false };
    }

    // 有修改
    const headers = normalizeHeaders(metaObj.headers);
    return {
      modified: true,
      method: typeof metaObj.method === "string" ? metaObj.method : undefined,
      url: typeof metaObj.url === "string" ? metaObj.url : undefined,
      headers,
      body,
    };
  }

  async rewriteResponse(params: ResponseHookParams): Promise<ResponseHookResult> {
    const { meta, body } = await this.postEnvelope(
      "hook-res-requestBody",
      {
        statusCode: params.statusCode,
        statusMessage: params.statusMessage,
        headers: params.headers,
        bodyLength: params.body.length,
      },
      params.body,
      params.signal,
    );

    const metaObj = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};

    // 检查是否被跳过（插件返回 null）
    if (metaObj.skipped === true) {
      return { skipped: true };
    }

    // 检查是否未修改
    if (metaObj.modified === false) {
      return { modified: false };
    }

    // 有修改
    const headers = normalizeHeaders(metaObj.headers);
    return {
      modified: true,
      statusCode: typeof metaObj.statusCode === "number" ? metaObj.statusCode : undefined,
      statusMessage: typeof metaObj.statusMessage === "string" ? metaObj.statusMessage : undefined,
      headers,
      body,
    };
  }

  async stop(): Promise<void> {
    if (this.callbackServer) {
      await new Promise<void>((resolve, reject) =>
        this.callbackServer!.close((err) => (err ? reject(err) : resolve())),
      ).catch(() => undefined);
      this.callbackServer = null;
    }

    if (this.process) {
      this.process.kill();
      this.process = null;
      this.listenUrl = null;
      this.readyPromise = null;
      debug(`[HookPool:${this.hashId}] Stopped`);
    }
  }
}

class HooksPool {
  private pool = new Map<string, HookProcess>();
  private pending = new Map<string, Promise<HookProcess>>();

  async acquire(config: HookConfig): Promise<HookProcess> {
    const hashId = computeConfigHash(config);

    // 已存在，直接返回
    const existing = this.pool.get(hashId);
    if (existing) {
      existing.addRef();
      return existing;
    }

    // 正在启动中，等待完成后返回
    const pendingPromise = this.pending.get(hashId);
    if (pendingPromise) {
      const hook = await pendingPromise;
      hook.addRef();
      return hook;
    }

    // 创建启动 promise 并记录，防止重入
    const startPromise = (async () => {
      const hook = new HookProcess(config, hashId);
      await hook.start();
      this.pool.set(hashId, hook);
      this.pending.delete(hashId);
      return hook;
    })();

    this.pending.set(hashId, startPromise);

    const hook = await startPromise;
    hook.addRef();
    return hook;
  }

  async release(hook: HookProcess): Promise<void> {
    if (hook.release()) {
      this.pool.delete(hook.hashId);
      await hook.stop();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.pool.values()].map((h) => h.stop()));
    this.pool.clear();
  }

  get size(): number {
    return this.pool.size;
  }
}

const globalHooksPool = new HooksPool();

/** 请求 hooks 执行结果 */
export interface RequestHooksExecutionResult {
  /** 最终的请求参数 */
  params: RequestHookParams;
  /** 每层 hook 的执行结果 */
  layers: HookLayer[];
  /** 是否有任何修改 */
  hasChanges: boolean;
  /** 短路响应（如果有插件要求直接返回） */
  respondWith?: {
    statusCode: number;
    headers?: Record<string, string | string[]>;
    body?: Buffer;
  };
}

/** 响应 hooks 执行结果 */
export interface ResponseHooksExecutionResult {
  /** 最终的响应参数 */
  params: ResponseHookParams;
  /** 每层 hook 的执行结果 */
  layers: HookLayer[];
  /** 是否有任何修改 */
  hasChanges: boolean;
}

export class HooksExecutor {
  /** 实例级 hooks（同时用于 request 和 response） */
  private instanceHookProcesses: HookProcess[] = [];
  /** Forward 级 hooks（同时用于 request 和 response） */
  private forwardHookProcesses: HookProcess[] = [];

  constructor(
    private instanceName: string,
    private instanceHooks: HooksConfig | null | undefined,
  ) {}

  private applyRequestPatch(
    current: RequestHookParams,
    patch: RequestHookResult,
  ): RequestHookParams {
    if (patch.skipped || patch.modified === false) {
      return current;
    }
    return {
      ...current,
      method: patch.method ?? current.method,
      url: patch.url ?? current.url,
      headers: patch.headers ?? current.headers,
      body: patch.body ?? current.body,
    };
  }

  private applyResponsePatch(
    current: ResponseHookParams,
    patch: ResponseHookResult,
  ): ResponseHookParams {
    if (patch.skipped || patch.modified === false) {
      return current;
    }
    return {
      ...current,
      statusCode: patch.statusCode ?? current.statusCode,
      statusMessage: patch.statusMessage ?? current.statusMessage,
      headers: patch.headers ?? current.headers,
      body: patch.body ?? current.body,
    };
  }

  async start(): Promise<void> {
    const configs = normalizeHooksConfig(this.instanceHooks);

    for (const config of configs) {
      const hook = await globalHooksPool.acquire(config);
      this.instanceHookProcesses.push(hook);
    }

    if (configs.length > 0) {
      debug(
        `[HooksExecutor:${this.instanceName}] Started with ${configs.length} hooks`,
      );
    }
  }

  async stop(): Promise<void> {
    await Promise.all([
      ...this.instanceHookProcesses.map((h) => globalHooksPool.release(h)),
      ...this.forwardHookProcesses.map((h) => globalHooksPool.release(h)),
    ]);

    this.instanceHookProcesses = [];
    this.forwardHookProcesses = [];
  }

  async setForwardHooks(forwardName: string, hooks: HooksConfig | null | undefined): Promise<void> {
    const oldHooks = this.forwardHookProcesses;
    const configs = normalizeHooksConfig(hooks);
    const newHooks: HookProcess[] = [];

    for (const config of configs) {
      const hook = await globalHooksPool.acquire(config);
      newHooks.push(hook);
    }

    this.forwardHookProcesses = newHooks;
    await Promise.all(oldHooks.map((h) => globalHooksPool.release(h)));

    if (configs.length > 0) {
      debug(
        `[HooksExecutor:${this.instanceName}/${forwardName}] Set forward hooks: ${configs.length}`,
      );
    }
  }

  /** 执行请求 hooks 并返回层层记录 */
  async executeRequestHooksWithLayers(
    params: RequestHookParams,
    bodyToDataUrl: (body: Buffer) => string | null,
  ): Promise<RequestHooksExecutionResult> {
    let result = params;
    const layers: HookLayer[] = [];
    let hasChanges = false;

    const allHooks = [...this.instanceHookProcesses, ...this.forwardHookProcesses];

    for (const hook of allHooks) {
      const hookResult = await hook.rewriteRequest(result);
      const pluginName = hook.pluginName;

      // 检查是否是 respondWith - 短路请求
      if (hookResult.respondWith) {
        layers.push({ pluginName, modified: true });
        return {
          params: result,
          layers,
          hasChanges: true,
          respondWith: hookResult.respondWith,
        };
      }

      if (hookResult.skipped) {
        // 插件返回 null，不记录该层
        continue;
      }

      if (hookResult.modified === false) {
        // 处理过但未修改
        layers.push({ pluginName, modified: false });
      } else {
        // 有修改
        hasChanges = true;
        const nextResult = this.applyRequestPatch(result, hookResult);
        // 自动添加 plugin-processed header
        nextResult.headers = addPluginProcessedHeader(nextResult.headers, pluginName);
        layers.push({
          pluginName,
          modified: true,
          method: nextResult.method,
          url: nextResult.url,
          headers: nextResult.headers,
          bodyDataUrl: bodyToDataUrl(nextResult.body),
          bodySize: nextResult.body.length,
        });
        result = nextResult;
      }
    }

    return { params: result, layers, hasChanges };
  }

  /** 执行响应 hooks 并返回层层记录 */
  async executeResponseHooksWithLayers(
    params: ResponseHookParams,
    bodyToDataUrl: (body: Buffer) => string | null,
    getContentType: (headers: Record<string, string | string[]>) => string | null,
  ): Promise<ResponseHooksExecutionResult> {
    let result = params;
    const layers: HookLayer[] = [];
    let hasChanges = false;

    const allHooks = [...this.forwardHookProcesses, ...this.instanceHookProcesses];

    for (const hook of allHooks) {
      const hookResult = await hook.rewriteResponse(result);
      const pluginName = hook.pluginName;

      if (hookResult.skipped) {
        continue;
      }

      if (hookResult.modified === false) {
        layers.push({ pluginName, modified: false });
      } else {
        hasChanges = true;
        const nextResult = this.applyResponsePatch(result, hookResult);
        layers.push({
          pluginName,
          modified: true,
          statusCode: nextResult.statusCode,
          statusMessage: nextResult.statusMessage,
          headers: nextResult.headers,
          bodyDataUrl: bodyToDataUrl(nextResult.body),
          bodySize: nextResult.body.length,
          contentType: getContentType(nextResult.headers),
        });
        result = nextResult;
      }
    }

    return { params: result, layers, hasChanges };
  }

  /** 向后兼容：执行请求 hooks */
  async executeRequestHooks(params: RequestHookParams): Promise<RequestHookParams> {
    const { params: result } = await this.executeRequestHooksWithLayers(
      params,
      () => null, // 不需要 dataUrl
    );
    return result;
  }

  /** 向后兼容：执行响应 hooks */
  async executeResponseHooks(params: ResponseHookParams): Promise<ResponseHookParams> {
    const { params: result } = await this.executeResponseHooksWithLayers(
      params,
      () => null,
      () => null,
    );
    return result;
  }

  get hasHooks(): boolean {
    return this.instanceHookProcesses.length > 0 || this.forwardHookProcesses.length > 0;
  }

  get hasRequestHooks(): boolean {
    return this.hasHooks;
  }

  get hasResponseHooks(): boolean {
    return this.hasHooks;
  }
}

export function getHooksPoolStats(): { size: number } {
  return { size: globalHooksPool.size };
}

export async function stopAllHooks(): Promise<void> {
  await globalHooksPool.stopAll();
}
