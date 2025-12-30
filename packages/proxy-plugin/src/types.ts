import type { z } from "zod";
import type { PluginStore } from "./plugin-store";

/**
 * 请求元数据
 */
export interface RequestMeta {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  bodyLength?: number;
}

/**
 * 响应元数据
 */
export interface ResponseMeta {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  bodyLength?: number;
}

/**
 * 请求 hook 参数
 */
export interface RequestHookParams<TStore = unknown> {
  meta: RequestMeta;
  body: Buffer;
  /** 插件存储（需定义 storeSchema 才能使用，框架自动注入） */
  store?: PluginStore<TStore>;
}

/**
 * 请求 hook 返回值
 * - 返回 { modified: false } 表示插件处理过但未修改内容
 * - 返回 { meta, body } 表示有修改
 * - 返回 { respondWith } 表示短路请求，直接返回响应
 * - 返回 null/undefined 表示跳过（不记录该层）
 */
export type RequestHookResult = 
  | { modified: false }
  | { modified?: true; meta?: Partial<RequestMeta>; body?: Buffer }
  | { respondWith: { statusCode: number; body?: string | Buffer; headers?: Record<string, string> } };

/**
 * 响应 hook 参数
 */
export interface ResponseHookParams<TStore = unknown> {
  meta: ResponseMeta;
  body: Buffer;
  /** 原始请求的元数据（不含 body，框架自动注入） */
  requestMeta?: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[]>;
  };
  /** 插件存储（需定义 storeSchema 才能使用，框架自动注入） */
  store?: PluginStore<TStore>;
}

/**
 * 响应 hook 返回值
 * - 返回 { modified: false } 表示插件处理过但未修改内容
 * - 返回 { meta, body } 表示有修改
 * - 返回 null/undefined 表示跳过（不记录该层）
 */
export type ResponseHookResult = 
  | { modified: false }
  | { modified?: true; meta?: Partial<ResponseMeta>; body?: Buffer };

/**
 * 插件配置
 */
export interface PluginConfig {
  /** 日志目录（可选） */
  logDir?: string;
  /** 是否启用调试日志 */
  debug?: boolean;
}

/**
 * 插件接口
 */
export interface ProxyPlugin<TStore = unknown> {
  /** 插件名称 */
  readonly name: string;

  /** 插件存储 schema（定义后才能使用 store） */
  readonly storeSchema?: z.ZodType<TStore>;

  /**
   * 处理请求 hook
   * @returns 返回修改后的请求，或 null/undefined 表示不修改
   */
  onRequest?(params: RequestHookParams): RequestHookResult | null | undefined | Promise<RequestHookResult | null | undefined>;

  /**
   * 处理响应 hook
   * @returns 返回修改后的响应，或 null/undefined 表示不修改
   */
  onResponse?(params: ResponseHookParams): ResponseHookResult | null | undefined | Promise<ResponseHookResult | null | undefined>;
}
