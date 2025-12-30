import type { HookConfig, HooksConfig } from "@/types/proxy";

function hasOwnProperty<K extends string>(
  obj: Record<string, unknown>,
  key: K,
): obj is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 将 HooksConfig 统一转为数组（仅做结构归一，不做 enabled/disabled 过滤） */
export function hooksConfigToList(hooks: HooksConfig | null | undefined): HookConfig[] {
  if (!hooks) return [];
  return Array.isArray(hooks) ? hooks : [hooks];
}

/** 从 HookConfig 提取插件名称（用于 UI 展示） */
export function getHookPluginName(config: HookConfig): string {
  const cfg = config.config;
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg) && hasOwnProperty(cfg, "name")) {
    return String(cfg.name);
  }

  const args = config.args ?? [];
  for (const arg of args) {
    if (arg.startsWith("@jixo/")) {
      return arg.replace("@jixo/", "");
    }
    if (arg.includes("proxy-plugin-") || arg.includes("proxy-anthropic-")) {
      return arg.split("/").pop() ?? arg;
    }
  }

  return config.command || "hook";
}

