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
  PrecheckResult,
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

// Private Headers
export {
  PRIVATE_HEADER_PREFIX,
  PrivateHeaders,
  isPrivateHeader,
  stripPrivateHeaders,
  extractPrivateHeaders,
  setPluginOrigin,
  addPluginProcessed,
  getPluginOrigin,
  getPluginsProcessed,
  parsePrivateHeaders,
  type PrivateHeaderKey,
  type PrivateHeaderInfo,
} from "./private-headers";

// Plugin UI
export {
  PLUGIN_UI_HEADER_PREFIX,
  PLUGIN_UI_STREAM_SUFFIX,
  isPluginUiHeader,
  isPluginUiStreamHeader,
  parsePluginUiHeaders,
  buildPluginUiHeaderKey,
  buildPluginUiStreamHeaderKey,
  type PluginTrayItem,
  type PluginUiPayload,
  type PluginUiData,
  type PluginUiMap,
} from "./plugin-ui";

// Plugin Config
export {
  getPluginConfig,
  getPluginConfigWithDefaults,
  definePluginConfig,
} from "./config";

// Plugin Store
export {
  buildPluginStoreKey,
  isPluginStoreHeader,
  createPluginStore,
  createMockStore,
  type PluginStore,
} from "./plugin-store";

// Stream helpers (used by plugins and proxy)
export type { StreamUtils } from "./stream-utils";
export {
  streamFromBuffer,
  readStreamToBuffer,
  readStreamToText,
  teeStream,
} from "./stream-utils";
