/**
 * 插件服务器
 *
 * 负责启动 HTTP 服务器并处理 hook 请求
 */

// NOTE: Subprocess HTTP hook server is no longer supported after the streaming hook breaking change.
import type { ProxyPlugin, PluginConfig } from "./types";

export interface PluginServerOptions extends PluginConfig {
  plugin: ProxyPlugin;
}

/**
 * 启动插件服务器
 */
export async function startPluginServer(options: PluginServerOptions): Promise<void> {
  const { plugin } = options;
  throw new Error(
    `[${plugin.name}] startPluginServer is no longer supported: hooks are now in-process and streaming-native.`,
  );
}

/**
 * 定义并启动插件（简化 API）
 */
export function definePlugin(plugin: ProxyPlugin, config?: PluginConfig): void {
  void config;
  throw new Error(
    `[${plugin.name}] definePlugin is no longer supported: hooks are now in-process and streaming-native.`,
  );
}
