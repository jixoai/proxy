/**
 * 插件配置工具
 *
 * 从环境变量 PLUGIN_CONFIG 读取配置
 */

/**
 * 从环境变量读取插件配置
 * @returns 解析后的配置对象，如果没有配置则返回空对象
 */
export function getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(): T {
  const configStr = process.env.PLUGIN_CONFIG;
  if (!configStr) {
    return {} as T;
  }

  try {
    return JSON.parse(configStr) as T;
  } catch (err) {
    console.error("[PluginConfig] Failed to parse PLUGIN_CONFIG:", err);
    return {} as T;
  }
}

/**
 * 从环境变量读取插件配置，带默认值
 */
export function getPluginConfigWithDefaults<T extends Record<string, unknown>>(
  defaults: T
): T {
  const config = getPluginConfig<Partial<T>>();
  return { ...defaults, ...config };
}

/**
 * 定义插件配置类型的辅助函数（用于类型推断）
 */
export function definePluginConfig<T extends Record<string, unknown>>(
  defaults: T
): () => T {
  return () => getPluginConfigWithDefaults(defaults);
}
