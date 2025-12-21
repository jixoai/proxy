/**
 * 私有 Headers 工具
 *
 * 私有 Headers 以 `-x-jixo-proxy-` 为前缀，仅用于代理服务器内部通信：
 * - 这些 headers 会被记录到数据库
 * - 但不会被转发到远程服务器
 *
 * 命名约定：
 * - -x-jixo-proxy-plugin-origin: 请求的发起插件（如心跳请求）
 * - -x-jixo-proxy-plugin-processed: 处理过该请求的插件列表（逗号分隔）
 * - -x-jixo-proxy-session-id: 会话标识
 * - -x-jixo-proxy-ping-count: 心跳计数
 */

export const PRIVATE_HEADER_PREFIX = "-x-jixo-proxy-";

export const PrivateHeaders = {
  /** 请求的发起插件 */
  PLUGIN_ORIGIN: "-x-jixo-proxy-plugin-origin",
  /** 处理过该请求的插件列表（逗号分隔） */
  PLUGIN_PROCESSED: "-x-jixo-proxy-plugin-processed",
  /** 会话标识 */
  SESSION_ID: "-x-jixo-proxy-session-id",
  /** 心跳计数 */
  PING_COUNT: "-x-jixo-proxy-ping-count",
  /** 请求类型：normal, ping, prefetch 等 */
  REQUEST_TYPE: "-x-jixo-proxy-request-type",
  /** 原始 Proxy URL（用于插件发起回环请求，如心跳） */
  PROXY_URL: "-x-jixo-proxy-url",
} as const;

export type PrivateHeaderKey = (typeof PrivateHeaders)[keyof typeof PrivateHeaders];

/**
 * 检查 header key 是否为私有 header
 */
export function isPrivateHeader(key: string): boolean {
  return key.toLowerCase().startsWith(PRIVATE_HEADER_PREFIX);
}

/**
 * 从 headers 中过滤掉私有 headers
 * @returns 不含私有 headers 的新对象
 */
export function stripPrivateHeaders<T extends Record<string, unknown>>(headers: T): T {
  const result = {} as T;
  for (const [key, value] of Object.entries(headers)) {
    if (!isPrivateHeader(key)) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * 从 headers 中提取私有 headers
 * @returns 只含私有 headers 的对象
 */
export function extractPrivateHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isPrivateHeader(key) && value !== undefined) {
      result[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
    }
  }
  return result;
}

/**
 * 设置插件来源标记
 */
export function setPluginOrigin(
  headers: Record<string, string>,
  pluginName: string
): Record<string, string> {
  return {
    ...headers,
    [PrivateHeaders.PLUGIN_ORIGIN]: pluginName,
  };
}

/**
 * 添加插件处理标记（追加到已有列表）
 */
export function addPluginProcessed(
  headers: Record<string, string | string[] | undefined>,
  pluginName: string
): Record<string, string> {
  const existing = headers[PrivateHeaders.PLUGIN_PROCESSED];
  const list = existing
    ? (Array.isArray(existing) ? existing.join(",") : existing).split(",")
    : [];

  if (!list.includes(pluginName)) {
    list.push(pluginName);
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(",") : value;
    }
  }
  result[PrivateHeaders.PLUGIN_PROCESSED] = list.join(",");

  return result;
}

/**
 * 获取插件来源
 */
export function getPluginOrigin(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const value = headers[PrivateHeaders.PLUGIN_ORIGIN];
  if (!value) return null;
  const result = Array.isArray(value) ? value[0] : value;
  return result ?? null;
}

/**
 * 获取处理过该请求的插件列表
 */
export function getPluginsProcessed(
  headers: Record<string, string | string[] | undefined>
): string[] {
  const value = headers[PrivateHeaders.PLUGIN_PROCESSED];
  if (!value) return [];
  const str = Array.isArray(value) ? value.join(",") : value;
  return str.split(",").filter(Boolean);
}

/**
 * 解析所有私有 header 信息
 */
export interface PrivateHeaderInfo {
  pluginOrigin: string | null;
  pluginsProcessed: string[];
  sessionId: string | null;
  pingCount: number | null;
  requestType: string | null;
}

export function parsePrivateHeaders(
  headers: Record<string, string | string[] | undefined>
): PrivateHeaderInfo {
  const getValue = (key: string): string | null => {
    const v = headers[key];
    if (v === undefined || v === null) return null;
    const result = Array.isArray(v) ? v[0] : v;
    return result ?? null;
  };

  const pingCountStr = getValue(PrivateHeaders.PING_COUNT);

  return {
    pluginOrigin: getValue(PrivateHeaders.PLUGIN_ORIGIN),
    pluginsProcessed: getPluginsProcessed(headers),
    sessionId: getValue(PrivateHeaders.SESSION_ID),
    pingCount: pingCountStr ? parseInt(pingCountStr, 10) : null,
    requestType: getValue(PrivateHeaders.REQUEST_TYPE),
  };
}
