import { spawn, type Subprocess } from "bun";
import type { ProxyPlugin, PluginStore, PrecheckResult, RequestMeta, ResponseMeta } from "@jixo/proxy-plugin";
import { createPluginStore } from "@jixo/proxy-plugin";
import type { HookConfig, HooksConfig, HookLayer } from "../types/proxy";

/** 私有 header：记录处理过该请求的插件列表 */
const HEADER_PLUGIN_PROCESSED = "-x-jixo-proxy-plugin-processed";

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

function normalizeHooksConfig(hooks: HooksConfig | null | undefined): HookConfig[] {
  if (!hooks) return [];
  const list = Array.isArray(hooks) ? hooks : [hooks];
  return list.filter((hook) => hook.disabled !== true);
}

function getPluginName(config: HookConfig): string {
  if (config.config && typeof config.config === "object" && "name" in config.config) {
    return String((config.config as any).name);
  }
  const args = config.args ?? [];
  for (const arg of args) {
    if (arg.startsWith("@jixo/")) return arg.replace("@jixo/", "");
    if (arg.includes("proxy-plugin-") || arg.includes("proxy-anthropic-")) {
      return arg.split("/").pop() ?? arg;
    }
  }
  return config.command;
}

async function importPlugin(config: HookConfig): Promise<ProxyPlugin> {
  if (config.type !== "http") {
    throw new Error(`Unsupported hook type: ${config.type}`);
  }
  const args = config.args ?? [];
  const entryArg = args.find((a) => a.startsWith("@jixo/")||a.endsWith(".ts"));
  if (!entryArg) {
    throw new Error(`Hook config missing package entry: ${config.command} ${args.join(" ")}`);
  }
  const mod = await import(entryArg);

  const pluginConfig =
    config.config && typeof config.config === "object" && !Array.isArray(config.config)
      ? config.config
      : undefined;

  const candidates: Array<() => unknown> = [
    () => (typeof (mod as any).default === "function" ? (mod as any).default(pluginConfig) : (mod as any).default),
    () => (typeof (mod as any).plugin === "function" ? (mod as any).plugin(pluginConfig) : (mod as any).plugin),
    () => (typeof (mod as any).createPlugin === "function" ? (mod as any).createPlugin(pluginConfig) : undefined),
    () =>
      typeof (mod as any).createDroidPlugin === "function"
        ? (mod as any).createDroidPlugin(pluginConfig)
        : undefined,
    () =>
      typeof (mod as any).createResponses4ClaudeCodePlugin === "function"
        ? (mod as any).createResponses4ClaudeCodePlugin(pluginConfig)
        : undefined,
    () => mod,
  ];

  for (const getCandidate of candidates) {
    const value = getCandidate();
    if (value && typeof value === "object" && typeof (value as any).name === "string") {
      return value as ProxyPlugin;
    }
  }

  throw new Error(`Invalid plugin module export for ${entryArg}`);
}

export interface RequestHookParams {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface RequestHookResult {
  skipped?: boolean;
  modified?: boolean;
  respondWith?: { statusCode: number; headers?: Record<string, string | string[]>; body?: Buffer };
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: ReadableStream<Uint8Array>;
}

export interface ResponseHookParams {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  body: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
  requestMeta?: { method: string; url: string; headers: Record<string, string | string[]> };
}

export interface ResponseHookResult {
  skipped?: boolean;
  modified?: boolean;
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  body?: ReadableStream<Uint8Array>;
}

export type LoadedHook = {
  pluginName: string;
  plugin: ProxyPlugin;
  store?: PluginStore<any>;
};

async function loadHooks(hooks: HookConfig[]): Promise<LoadedHook[]> {
  const out: LoadedHook[] = [];
  for (const config of hooks) {
    const plugin = await importPlugin(config);
    out.push({ pluginName: getPluginName(config), plugin });
  }
  return out;
}

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

/** 预检结果汇总 */
export interface PrecheckSummary {
  /** 是否需要缓冲 body（任一插件返回 true） */
  needsBuffer: boolean;
  /** 需要处理的插件列表 */
  activePlugins: string[];
  /** 全部返回 passthrough 或 false */
  canPassthrough: boolean;
}

export class HooksExecutor {
  private instanceHooksLoaded: LoadedHook[] = [];

  constructor(
    private instanceName: string,
    private instanceHooks: HooksConfig | null | undefined,
  ) {}

  async start(): Promise<void> {
    const configs = normalizeHooksConfig(this.instanceHooks);
    this.instanceHooksLoaded = await loadHooks(configs);
  }

  async stop(): Promise<void> {
    this.instanceHooksLoaded = [];
  }

  /**
   * 加载 forward hooks（请求级别，不再使用共享状态）
   * @deprecated 使用 loadForwardHooks 替代
   */
  async setForwardHooks(_forwardName: string, hooks: HooksConfig | null | undefined): Promise<void> {
    // 空实现，保持向后兼容
    console.warn('[HooksExecutor] setForwardHooks is deprecated and has no effect');
  }

  /**
   * 加载 forward hooks 并返回（请求级别，避免并发竞态）
   */
  async loadForwardHooks(hooks: HooksConfig | null | undefined): Promise<LoadedHook[]> {
    const configs = normalizeHooksConfig(hooks);
    return await loadHooks(configs);
  }

  /** 请求预检：决定是否需要缓冲请求 body */
  async precheckRequest(meta: RequestMeta, forwardHooksLoaded: LoadedHook[] = []): Promise<PrecheckSummary> {
    const allHooks = [...this.instanceHooksLoaded, ...forwardHooksLoaded];
    const activePlugins: string[] = [];
    let needsBuffer = false;
    let allPassthrough = true;

    for (const hook of allHooks) {
      if (!hook.plugin.onRequest) continue;

      let result: PrecheckResult;
      if (hook.plugin.shouldProcessRequest) {
        result = await hook.plugin.shouldProcessRequest(meta);
      } else {
        // 向后兼容：没有预检方法则默认需要处理
        result = true;
      }

      if (result === true) {
        needsBuffer = true;
        allPassthrough = false;
        activePlugins.push(hook.pluginName);
      } else if (result === 'passthrough') {
        // passthrough 不需要缓冲，但不算 false
      } else {
        // false - 跳过
        allPassthrough = false;
      }
    }

    return {
      needsBuffer,
      activePlugins,
      canPassthrough: allPassthrough && !needsBuffer,
    };
  }

  /** 响应预检：决定是否需要缓冲响应 body */
  async precheckResponse(meta: ResponseMeta, requestMeta?: RequestMeta, forwardHooksLoaded: LoadedHook[] = []): Promise<PrecheckSummary> {
    const allHooks = [...forwardHooksLoaded, ...this.instanceHooksLoaded];
    const activePlugins: string[] = [];
    let needsBuffer = false;
    let allPassthrough = true;

    for (const hook of allHooks) {
      if (!hook.plugin.onResponse) continue;

      let result: PrecheckResult;
      if (hook.plugin.shouldProcessResponse) {
        result = await hook.plugin.shouldProcessResponse(meta, requestMeta);
      } else {
        // 向后兼容：没有预检方法则默认需要处理
        result = true;
      }

      if (result === true) {
        needsBuffer = true;
        allPassthrough = false;
        activePlugins.push(hook.pluginName);
      } else if (result === 'passthrough') {
        // passthrough 不需要缓冲
      } else {
        // false - 跳过
        allPassthrough = false;
      }
    }

    return {
      needsBuffer,
      activePlugins,
      canPassthrough: allPassthrough && !needsBuffer,
    };
  }

  /** 执行请求 hooks 并返回层层记录 */
  async executeRequestHooksWithLayers(
    params: RequestHookParams,
    bodyToDataUrl: (body: Buffer) => string | null,
    forwardHooksLoaded: LoadedHook[] = [],
  ): Promise<RequestHooksExecutionResult> {
    let result = params;
    const layers: HookLayer[] = [];
    let hasChanges = false;

    const allHooks = [...this.instanceHooksLoaded, ...forwardHooksLoaded];

    for (const hook of allHooks) {
      const pluginName = hook.pluginName;

      const store = createPluginStore(pluginName, (hook.plugin as any).storeSchema, result.headers);
      const pluginResult = hook.plugin.onRequest
        ? await hook.plugin.onRequest({ meta: { method: result.method, url: result.url, headers: result.headers }, body: result.body, store })
        : null;

      if (!pluginResult) {
        continue;
      }

      if ("respondWith" in pluginResult) {
        const { statusCode, headers, body } = pluginResult.respondWith;
        layers.push({ pluginName, modified: true });
        return {
          params: result,
          layers,
          hasChanges: true,
          respondWith: {
            statusCode,
            headers,
            body: body ? Buffer.from(body) : Buffer.alloc(0),
          },
        };
      }

      if ("modified" in pluginResult && pluginResult.modified === false) {
        layers.push({ pluginName, modified: false });
        continue;
      }

      hasChanges = true;
      const nextMethod = pluginResult.meta?.method ?? result.method;
      const nextUrl = pluginResult.meta?.url ?? result.url;
      const nextHeaders = (pluginResult.meta?.headers as any) ?? result.headers;
      const nextBody = pluginResult.body ?? result.body;

      const nextResult: RequestHookParams = {
        ...result,
        method: nextMethod,
        url: nextUrl,
        headers: addPluginProcessedHeader(nextHeaders, pluginName),
        body: nextBody,
      };

      layers.push({
        pluginName,
        modified: true,
        method: nextResult.method,
        url: nextResult.url,
        headers: nextResult.headers,
        bodyDataUrl: null,
      });
      result = nextResult;
    }

    return { params: result, layers, hasChanges };
  }

  /** 执行响应 hooks 并返回层层记录 */
  async executeResponseHooksWithLayers(
    params: ResponseHookParams,
    bodyToDataUrl: (body: Buffer) => string | null,
    getContentType: (headers: Record<string, string | string[]>) => string | null,
    forwardHooksLoaded: LoadedHook[] = [],
  ): Promise<ResponseHooksExecutionResult> {
    let result = params;
    const layers: HookLayer[] = [];
    let hasChanges = false;

    const allHooks = [...forwardHooksLoaded, ...this.instanceHooksLoaded];

    for (const hook of allHooks) {
      const pluginName = hook.pluginName;
      const store = createPluginStore(pluginName, (hook.plugin as any).storeSchema, result.requestMeta?.headers);
      const pluginResult = hook.plugin.onResponse
        ? await hook.plugin.onResponse({
            meta: { statusCode: result.statusCode, statusMessage: result.statusMessage, headers: result.headers },
            body: result.body,
            requestMeta: result.requestMeta,
            store,
          })
        : null;

      if (!pluginResult) continue;
      if ("modified" in pluginResult && pluginResult.modified === false) {
        layers.push({ pluginName, modified: false });
        continue;
      }

      hasChanges = true;
      const nextStatusCode = pluginResult.meta?.statusCode ?? result.statusCode;
      const nextStatusMessage = pluginResult.meta?.statusMessage ?? result.statusMessage;
      const nextHeaders = (pluginResult.meta?.headers as any) ?? result.headers;
      const nextBody = pluginResult.body ?? result.body;

      const nextResult: ResponseHookParams = {
        ...result,
        statusCode: nextStatusCode,
        statusMessage: nextStatusMessage,
        headers: nextHeaders,
        body: nextBody,
      };

      layers.push({
        pluginName,
        modified: true,
        statusCode: nextResult.statusCode,
        statusMessage: nextResult.statusMessage,
        headers: nextResult.headers,
        bodyDataUrl: null,
        contentType: getContentType(nextResult.headers),
      });

      result = nextResult;
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
    return this.instanceHooksLoaded.length > 0;
  }

  get hasRequestHooks(): boolean {
    return this.hasHooks;
  }

  get hasResponseHooks(): boolean {
    return this.hasHooks;
  }

  /**
   * 判断（实例级 + 本次请求加载的 forward 级）是否存在请求 hook。
   *
   * forward hooks 现为请求级局部状态（见 loadForwardHooks），无法由实例状态判断，
   * 因此执行入口的总开关必须把本次请求的 forwardHooksLoaded 一并算入，
   * 否则 instance 顶层无 hooks 时，forward 级 hook 会被整体跳过。
   */
  hasRequestHooksFor(forwardHooksLoaded: LoadedHook[] = []): boolean {
    if (this.instanceHooksLoaded.some((hook) => hook.plugin.onRequest)) return true;
    return forwardHooksLoaded.some((hook) => hook.plugin.onRequest);
  }

  /** 判断（实例级 + 本次请求加载的 forward 级）是否存在响应 hook。 */
  hasResponseHooksFor(forwardHooksLoaded: LoadedHook[] = []): boolean {
    if (this.instanceHooksLoaded.some((hook) => hook.plugin.onResponse)) return true;
    return forwardHooksLoaded.some((hook) => hook.plugin.onResponse);
  }
}

export function getHooksPoolStats(): { size: number } {
  return { size: 0 };
}

export async function stopAllHooks(): Promise<void> {
  // no-op (hooks are in-process)
}
