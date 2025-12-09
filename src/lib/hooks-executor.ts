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
  private instanceRequestHook: HookProcess | null = null;
  private instanceResponseHook: HookProcess | null = null;
  private forwardRequestHook: HookProcess | null = null;
  private forwardResponseHook: HookProcess | null = null;

  constructor(
    private instanceName: string,
    private instanceHooks: HooksConfig | null | undefined,
  ) {}

  async start(): Promise<void> {
    if (this.instanceHooks?.request) {
      this.instanceRequestHook = new HookProcess(
        this.instanceHooks.request,
        `${this.instanceName}/instance/request`,
      );
      await this.instanceRequestHook.start();
    }
    if (this.instanceHooks?.response) {
      this.instanceResponseHook = new HookProcess(
        this.instanceHooks.response,
        `${this.instanceName}/instance/response`,
      );
      await this.instanceResponseHook.start();
    }
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.instanceRequestHook?.stop(),
      this.instanceResponseHook?.stop(),
      this.forwardRequestHook?.stop(),
      this.forwardResponseHook?.stop(),
    ]);
  }

  /** 为特定 forward 设置 hooks */
  async setForwardHooks(
    forwardName: string,
    hooks: HooksConfig | null | undefined,
  ): Promise<void> {
    await this.forwardRequestHook?.stop();
    await this.forwardResponseHook?.stop();
    this.forwardRequestHook = null;
    this.forwardResponseHook = null;

    if (hooks?.request) {
      this.forwardRequestHook = new HookProcess(
        hooks.request,
        `${this.instanceName}/${forwardName}/request`,
      );
      await this.forwardRequestHook.start();
    }
    if (hooks?.response) {
      this.forwardResponseHook = new HookProcess(
        hooks.response,
        `${this.instanceName}/${forwardName}/response`,
      );
      await this.forwardResponseHook.start();
    }
  }

  /** 执行 request hooks：先 instance 后 forward */
  async executeRequestHooks(
    params: RequestHookParams,
  ): Promise<RequestHookParams> {
    let result = params;

    if (this.instanceRequestHook) {
      const hookResult = await this.instanceRequestHook.call<RequestHookResult>(
        "rewrite_request",
        result,
      );
      result = { ...result, ...hookResult };
    }

    if (this.forwardRequestHook) {
      const hookResult = await this.forwardRequestHook.call<RequestHookResult>(
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

    // response 先 forward 后 instance
    if (this.forwardResponseHook) {
      const hookResult =
        await this.forwardResponseHook.call<ResponseHookResult>(
          "rewrite_response_headers",
          result,
        );
      result = { ...result, ...hookResult };
    }

    if (this.instanceResponseHook) {
      const hookResult =
        await this.instanceResponseHook.call<ResponseHookResult>(
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

    if (this.forwardResponseHook) {
      result = await this.forwardResponseHook.transformChunk(result);
    }

    if (this.instanceResponseHook) {
      result = await this.instanceResponseHook.transformChunk(result);
    }

    return result;
  }

  /** 结束 response 流 */
  async endResponseStream(): Promise<Uint8Array | null> {
    const chunks: Uint8Array[] = [];

    if (this.forwardResponseHook) {
      const chunk = await this.forwardResponseHook.endStream();
      if (chunk) chunks.push(chunk);
    }

    if (this.instanceResponseHook) {
      const chunk = await this.instanceResponseHook.endStream();
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
    return !!(this.instanceRequestHook || this.forwardRequestHook);
  }

  get hasResponseHooks(): boolean {
    return !!(this.instanceResponseHook || this.forwardResponseHook);
  }
}
