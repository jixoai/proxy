import type { HookConfig, HooksConfig } from "@/types/proxy";

function hasOwnProperty<K extends string>(
  obj: Record<string, unknown>,
  key: K,
): obj is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HookConfigSummary {
  label: string;
  tooltip?: string;
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

function isModelRewriteHook(config: HookConfig): boolean {
  const args = config.args ?? [];
  return (
    args.some((arg) => arg.includes("proxy-plugin-model-rewrite")) ||
    config.command.includes("proxy-plugin-model-rewrite")
  );
}

function getModelRewriteSummary(config: HookConfig): HookConfigSummary[] {
  if (!isModelRewriteHook(config)) return [];

  const cfg = config.config;
  if (!isRecord(cfg) || !hasOwnProperty(cfg, "model")) return [];

  const model = cfg.model;
  if (typeof model === "string" && model.trim().length > 0) {
    return [{ label: `Model ${model.trim()}` }];
  }

  if (!isRecord(model)) return [];

  const rules = Object.entries(model).filter(
    ([pattern, replacement]) =>
      pattern.trim().length > 0 && typeof replacement === "string" && replacement.trim().length > 0,
  );
  if (rules.length === 0) return [];

  return [
    {
      label: `Model ${rules.length} 条规则`,
      tooltip: rules.map(([pattern, replacement]) => `${pattern} -> ${replacement}`).join("\n"),
    },
  ];
}

export function getHookConfigSummaries(config: HookConfig): HookConfigSummary[] {
  return [...getModelRewriteSummary(config)];
}
