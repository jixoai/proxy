/**
 * 插件存储
 *
 * 提供插件在 request/response 之间传递数据的能力
 * 数据存储在私有 header 中：-x-jixo-store-${pluginName}
 */

import type { z } from "zod";

const PLUGIN_STORE_PREFIX = "-x-jixo-store-";

/**
 * 创建一个 mock store（用于测试）
 * @param initialData 预设数据，get() 会返回此数据
 */
export function createMockStore<T>(initialData?: T): PluginStore<T> {
  let data: T | null = initialData ?? null;
  return {
    set(newData: T, headers: Record<string, string | string[]>): Record<string, string | string[]> {
      data = newData;
      return headers;
    },
    get(): T | null {
      return data;
    },
  };
}

export function buildPluginStoreKey(pluginName: string): string {
  return `${PLUGIN_STORE_PREFIX}${pluginName}`;
}

export function isPluginStoreHeader(key: string): boolean {
  return key.toLowerCase().startsWith(PLUGIN_STORE_PREFIX);
}

/**
 * 插件存储接口
 */
export interface PluginStore<T> {
  /** 设置数据，返回包含新 store header 的 headers */
  set(data: T, headers: Record<string, string | string[]>): Record<string, string | string[]>;
  /** 获取数据 */
  get(): T | null;
}

/**
 * 创建插件存储（框架内部使用）
 */
export function createPluginStore<T>(
  pluginName: string,
  schema: z.ZodType<T> | undefined,
  requestHeaders: Record<string, string | string[]> | undefined
): PluginStore<T> {
  const key = buildPluginStoreKey(pluginName);

  return {
    set(data: T, headers: Record<string, string | string[]>): Record<string, string | string[]> {
      if (!schema) {
        throw new Error(`Plugin "${pluginName}" must define storeSchema to use store.set()`);
      }
      const validated = schema.parse(data);
      return {
        ...headers,
        [key]: JSON.stringify(validated),
      };
    },

    get(): T | null {
      if (!schema) {
        throw new Error(`Plugin "${pluginName}" must define storeSchema to use store.get()`);
      }
      if (!requestHeaders) return null;
      const value = requestHeaders[key];
      if (!value) return null;
      try {
        const str = Array.isArray(value) ? value[0] ?? "" : value;
        if (!str) return null;
        return schema.parse(JSON.parse(str));
      } catch {
        return null;
      }
    },
  };
}
