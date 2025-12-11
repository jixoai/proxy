import { spawn, type Subprocess } from "bun";
import type { HookConfig, HooksConfig } from "../types/proxy";

/** JSON-RPC 2.0 请求 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

/** JSON-RPC 2.0 响应 */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** request hook 的参数 */
export interface RequestHookParams {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: string | null;
}

/** request hook 的返回值 */
export interface RequestHookResult {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: string | null;
}

/** response hook 的参数（流式） */
export interface ResponseHookParams {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
}

/** response hook 的返回值 */
export interface ResponseHookResult {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
}

/** 管理单个 hook 进程 */
class HookProcess {
  private process: Subprocess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private ready = false;

  constructor(
    private config: HookConfig,
    private name: string,
  ) {}

  async start(): Promise<void> {
    if (this.process) return;

    const args = [this.config.command, ...(this.config.args ?? [])];
    this.process = spawn(args, {
      cwd: this.config.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    this.readOutput();
    this.ready = true;
    console.log(`[Hook:${this.name}] Started: ${args.join(" ")}`);
  }

  private async readOutput(): Promise<void> {
    const stdout = this.process?.stdout;
    if (!stdout || typeof stdout === "number") return;
    const decoder = new TextDecoder();
    const reader = (stdout as ReadableStream<Uint8Array>).getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch (error) {
      console.error(`[Hook:${this.name}] Read error:`, error);
    } finally {
      reader.releaseLock();
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        console.warn(`[Hook:${this.name}] Invalid JSON:`, line);
      }
    }
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    if (!this.process || !this.ready) {
      throw new Error(`Hook process not ready: ${this.name}`);
    }

    const stdin = this.process.stdin;
    if (!stdin || typeof stdin === "number") {
      throw new Error(`Hook process stdin not available: ${this.name}`);
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      const data = JSON.stringify(request) + "\n";
      (stdin as { write(data: string): void }).write(data);
    });
  }

  /** 流式转发：将 chunk 发送到 hook 进程并返回处理后的 chunk */
  async transformChunk(chunk: Uint8Array): Promise<Uint8Array> {
    const base64 = Buffer.from(chunk).toString("base64");
    const result = await this.call<{ data: string }>("transform_chunk", {
      data: base64,
    });
    return Buffer.from(result.data, "base64");
  }

  /** 流式结束 */
  async endStream(): Promise<Uint8Array | null> {
    try {
      const result = await this.call<{ data?: string }>("end_stream", {});
      if (result.data) {
        return Buffer.from(result.data, "base64");
      }
    } catch {
      // ignore
    }
    return null;
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
    this.ready = false;
    console.log(`[Hook:${this.name}] Stopped`);
  }
}

/** hooks 执行器，管理 instance 和 forward 级别的 hooks */
export class HooksExecutor {
  private instanceRequestHooks: HookProcess[] = [];
  private instanceResponseHooks: HookProcess[] = [];
  private forwardRequestHooks: HookProcess[] = [];
  private forwardResponseHooks: HookProcess[] = [];

  constructor(
    private instanceName: string,
    private instanceHooks: HooksConfig | null | undefined,
  ) {}

  /** 将单个或数组的 hook 配置统一为数组 */
  private normalizeHooks(
    hooks: HookConfig | HookConfig[] | null | undefined,
  ): HookConfig[] {
    if (!hooks) return [];
    return Array.isArray(hooks) ? hooks : [hooks];
  }

  async start(): Promise<void> {
    const requestConfigs = this.normalizeHooks(this.instanceHooks?.request);
    const responseConfigs = this.normalizeHooks(this.instanceHooks?.response);

    for (const [i, config] of requestConfigs.entries()) {
      const hook = new HookProcess(
        config,
        `${this.instanceName}/instance/request[${i}]`,
      );
      await hook.start();
      this.instanceRequestHooks.push(hook);
    }

    for (const [i, config] of responseConfigs.entries()) {
      const hook = new HookProcess(
        config,
        `${this.instanceName}/instance/response[${i}]`,
      );
      await hook.start();
      this.instanceResponseHooks.push(hook);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([
      ...this.instanceRequestHooks.map((h) => h.stop()),
      ...this.instanceResponseHooks.map((h) => h.stop()),
      ...this.forwardRequestHooks.map((h) => h.stop()),
      ...this.forwardResponseHooks.map((h) => h.stop()),
    ]);
  }

  /** 为特定 forward 设置 hooks */
  async setForwardHooks(
    forwardName: string,
    hooks: HooksConfig | null | undefined,
  ): Promise<void> {
    await Promise.all(this.forwardRequestHooks.map((h) => h.stop()));
    await Promise.all(this.forwardResponseHooks.map((h) => h.stop()));
    this.forwardRequestHooks = [];
    this.forwardResponseHooks = [];

    const requestConfigs = this.normalizeHooks(hooks?.request);
    const responseConfigs = this.normalizeHooks(hooks?.response);

    for (const [i, config] of requestConfigs.entries()) {
      const hook = new HookProcess(
        config,
        `${this.instanceName}/${forwardName}/request[${i}]`,
      );
      await hook.start();
      this.forwardRequestHooks.push(hook);
    }

    for (const [i, config] of responseConfigs.entries()) {
      const hook = new HookProcess(
        config,
        `${this.instanceName}/${forwardName}/response[${i}]`,
      );
      await hook.start();
      this.forwardResponseHooks.push(hook);
    }
  }

  /** 执行 request hooks：先 instance 后 forward（类似 koa 中间件洋葱模型的下行阶段） */
  async executeRequestHooks(
    params: RequestHookParams,
  ): Promise<RequestHookParams> {
    let result = params;

    // instance request hooks 按顺序执行
    for (const hook of this.instanceRequestHooks) {
      const hookResult = await hook.call<RequestHookResult>(
        "rewrite_request",
        result,
      );
      result = { ...result, ...hookResult };
    }

    // forward request hooks 按顺序执行
    for (const hook of this.forwardRequestHooks) {
      const hookResult = await hook.call<RequestHookResult>(
        "rewrite_request",
        result,
      );
      result = { ...result, ...hookResult };
    }

    return result;
  }

  /** 执行 response hooks 的初始化：返回可能修改的 headers */
  async executeResponseHeaderHooks(
    params: ResponseHookParams,
  ): Promise<ResponseHookParams> {
    let result = params;

    // response 先 forward 后 instance（类似 koa 中间件洋葱模型的上行阶段）
    // forward response hooks 按顺序执行
    for (const hook of this.forwardResponseHooks) {
      const hookResult = await hook.call<ResponseHookResult>(
        "rewrite_response_headers",
        result,
      );
      result = { ...result, ...hookResult };
    }

    // instance response hooks 按顺序执行
    for (const hook of this.instanceResponseHooks) {
      const hookResult = await hook.call<ResponseHookResult>(
        "rewrite_response_headers",
        result,
      );
      result = { ...result, ...hookResult };
    }

    return result;
  }

  /** 转换 response chunk：先 forward 后 instance */
  async transformResponseChunk(chunk: Uint8Array): Promise<Uint8Array> {
    let result = chunk;

    for (const hook of this.forwardResponseHooks) {
      result = await hook.transformChunk(result);
    }

    for (const hook of this.instanceResponseHooks) {
      result = await hook.transformChunk(result);
    }

    return result;
  }

  /** 结束 response 流 */
  async endResponseStream(): Promise<Uint8Array | null> {
    const chunks: Uint8Array[] = [];

    for (const hook of this.forwardResponseHooks) {
      const chunk = await hook.endStream();
      if (chunk) chunks.push(chunk);
    }

    for (const hook of this.instanceResponseHooks) {
      const chunk = await hook.endStream();
      if (chunk) chunks.push(chunk);
    }

    if (chunks.length === 0) return null;
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  get hasRequestHooks(): boolean {
    return (
      this.instanceRequestHooks.length > 0 ||
      this.forwardRequestHooks.length > 0
    );
  }

  get hasResponseHooks(): boolean {
    return (
      this.instanceResponseHooks.length > 0 ||
      this.forwardResponseHooks.length > 0
    );
  }
}
