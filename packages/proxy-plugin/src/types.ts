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
export interface RequestHookParams {
  meta: RequestMeta;
  body: Buffer;
}

/**
 * 请求 hook 返回值
 */
export interface RequestHookResult {
  meta?: Partial<RequestMeta>;
  body?: Buffer;
}

/**
 * 响应 hook 参数
 */
export interface ResponseHookParams {
  meta: ResponseMeta;
  body: Buffer;
}

/**
 * 响应 hook 返回值
 */
export interface ResponseHookResult {
  meta?: Partial<ResponseMeta>;
  body?: Buffer;
}

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
export interface ProxyPlugin {
  /** 插件名称 */
  readonly name: string;

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
