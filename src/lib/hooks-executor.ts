import { spawn, type Subprocess } from "bun";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import createDebug from "debug";
import type { HookConfig, HooksConfig } from "../types/proxy";

const debug = createDebug("proxy:hooks");

export interface RequestHookParams {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  signal?: AbortSignal;
}

export interface RequestHookResult {
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

  constructor(
    private config: HookConfig,
    readonly hashId: string,
  ) {}

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

    this.process = spawn(args, {
      cwd: this.config.cwd,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, __CALLBACK_URL__: callback.url },
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
    const headers = normalizeHeaders(metaObj.headers);
    return {
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
    const headers = normalizeHeaders(metaObj.headers);
    return {
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

export class HooksExecutor {
  private instanceRequestHooks: HookProcess[] = [];
  private instanceResponseHooks: HookProcess[] = [];
  private forwardRequestHooks: HookProcess[] = [];
  private forwardResponseHooks: HookProcess[] = [];

  constructor(
    private instanceName: string,
    private instanceHooks: HooksConfig | null | undefined,
  ) {}

  private normalizeHooks(hooks: HookConfig | HookConfig[] | null | undefined): HookConfig[] {
    if (!hooks) return [];
    return Array.isArray(hooks) ? hooks : [hooks];
  }

  private applyRequestPatch(
    current: RequestHookParams,
    patch: RequestHookResult,
  ): RequestHookParams {
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
    return {
      ...current,
      statusCode: patch.statusCode ?? current.statusCode,
      statusMessage: patch.statusMessage ?? current.statusMessage,
      headers: patch.headers ?? current.headers,
      body: patch.body ?? current.body,
    };
  }

  async start(): Promise<void> {
    const reqresConfigs = this.normalizeHooks(this.instanceHooks?.reqres);
    const requestConfigs = [...reqresConfigs, ...this.normalizeHooks(this.instanceHooks?.request)];
    const responseConfigs = [...reqresConfigs, ...this.normalizeHooks(this.instanceHooks?.response)];

    for (const config of requestConfigs) {
      const hook = await globalHooksPool.acquire(config);
      this.instanceRequestHooks.push(hook);
    }

    for (const config of responseConfigs) {
      const hook = await globalHooksPool.acquire(config);
      this.instanceResponseHooks.push(hook);
    }

    if (requestConfigs.length > 0 || responseConfigs.length > 0) {
      debug(
        `[HooksExecutor:${this.instanceName}] Started with ${requestConfigs.length} request hooks, ${responseConfigs.length} response hooks`,
      );
    }
  }

  async stop(): Promise<void> {
    await Promise.all([
      ...this.instanceRequestHooks.map((h) => globalHooksPool.release(h)),
      ...this.instanceResponseHooks.map((h) => globalHooksPool.release(h)),
      ...this.forwardRequestHooks.map((h) => globalHooksPool.release(h)),
      ...this.forwardResponseHooks.map((h) => globalHooksPool.release(h)),
    ]);

    this.instanceRequestHooks = [];
    this.instanceResponseHooks = [];
    this.forwardRequestHooks = [];
    this.forwardResponseHooks = [];
  }

  async setForwardHooks(forwardName: string, hooks: HooksConfig | null | undefined): Promise<void> {
    // 保存旧的 hooks 引用，稍后释放
    const oldRequestHooks = this.forwardRequestHooks;
    const oldResponseHooks = this.forwardResponseHooks;

    // 先 acquire 新的 hooks（这样如果配置相同，引用计数会先+1）
    const reqresConfigs = this.normalizeHooks(hooks?.reqres);
    const requestConfigs = [...reqresConfigs, ...this.normalizeHooks(hooks?.request)];
    const responseConfigs = [...reqresConfigs, ...this.normalizeHooks(hooks?.response)];

    const newRequestHooks: HookProcess[] = [];
    const newResponseHooks: HookProcess[] = [];

    for (const config of requestConfigs) {
      const hook = await globalHooksPool.acquire(config);
      newRequestHooks.push(hook);
    }

    for (const config of responseConfigs) {
      const hook = await globalHooksPool.acquire(config);
      newResponseHooks.push(hook);
    }

    // 更新实例引用
    this.forwardRequestHooks = newRequestHooks;
    this.forwardResponseHooks = newResponseHooks;

    // 最后释放旧的 hooks（如果配置相同，引用计数-1后仍>0，不会销毁）
    await Promise.all(oldRequestHooks.map((h) => globalHooksPool.release(h)));
    await Promise.all(oldResponseHooks.map((h) => globalHooksPool.release(h)));

    if (requestConfigs.length > 0 || responseConfigs.length > 0) {
      debug(
        `[HooksExecutor:${this.instanceName}/${forwardName}] Set forward hooks: ${requestConfigs.length} request, ${responseConfigs.length} response`,
      );
    }
  }

  async executeRequestHooks(params: RequestHookParams): Promise<RequestHookParams> {
    let result = params;

    for (const hook of this.instanceRequestHooks) {
      const hookResult = await hook.rewriteRequest(result);
      result = this.applyRequestPatch(result, hookResult);
    }

    for (const hook of this.forwardRequestHooks) {
      const hookResult = await hook.rewriteRequest(result);
      result = this.applyRequestPatch(result, hookResult);
    }

    return result;
  }

  async executeResponseHooks(params: ResponseHookParams): Promise<ResponseHookParams> {
    let result = params;

    for (const hook of this.forwardResponseHooks) {
      const hookResult = await hook.rewriteResponse(result);
      result = this.applyResponsePatch(result, hookResult);
    }

    for (const hook of this.instanceResponseHooks) {
      const hookResult = await hook.rewriteResponse(result);
      result = this.applyResponsePatch(result, hookResult);
    }

    return result;
  }

  get hasRequestHooks(): boolean {
    return this.instanceRequestHooks.length > 0 || this.forwardRequestHooks.length > 0;
  }

  get hasResponseHooks(): boolean {
    return this.instanceResponseHooks.length > 0 || this.forwardResponseHooks.length > 0;
  }
}

export function getHooksPoolStats(): { size: number } {
  return { size: globalHooksPool.size };
}

export async function stopAllHooks(): Promise<void> {
  await globalHooksPool.stopAll();
}
