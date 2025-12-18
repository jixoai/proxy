/**
 * @jixo/proxy-plugin
 *
 * 代理插件开发框架，提供抽象接口和工具函数
 */

// Types
export type {
  RequestMeta,
  ResponseMeta,
  RequestHookParams,
  RequestHookResult,
  ResponseHookParams,
  ResponseHookResult,
  PluginConfig,
  ProxyPlugin,
} from "./types";

// Envelope
export { encodeEnvelope, decodeEnvelope } from "./envelope";

// Utils
export {
  isRecord,
  normalizeHeaders,
  isJsonContentType,
  isEventStreamContentType,
  safeParseJson,
} from "./utils";

// Logger
export { createLogger, type PluginLogger, type LoggerOptions } from "./logger";

// Server
export { startPluginServer, definePlugin, type PluginServerOptions } from "./server";
