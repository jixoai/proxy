import { z } from "zod";
import type {
  ProxyConfigFile,
  ProxyForwardConfig,
  ProxyInstanceConfig,
  ProxyGlobalSettings,
  ProxyInstanceSettings,
  HooksConfig,
} from "../types/proxy";
import { DEFAULT_DB_PATH_TEMPLATE } from "./runtime-paths";

const httpHookSchema = z.object({
  type: z.literal("http"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
});

const hookConfigSchema = httpHookSchema;

/** hook 字段 schema：单个对象或数组，兼容旧配置 */
const hookFieldSchema = z
  .union([hookConfigSchema, z.array(hookConfigSchema)])
  .optional()
  .nullable();

const hooksSchema = z
  .object({
    request: hookFieldSchema,
    response: hookFieldSchema,
    reqres: hookFieldSchema,
  })
  .optional()
  .nullable()
  .transform<HooksConfig | null>((value) => {
    if (!value) return null;
    if (!value.request && !value.response && !value.reqres) return null;
    return value;
  });

const headersSchema = z
  .any()
  .transform((value) => {
    if (value == null) return null;
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") {
        result[k] = v;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  })
  .default(null);

export const proxyForwardSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    name: z.string().min(1).trim(),
    enabled: z.boolean().default(true),
    target: z.string().url(),
    description: z.string().trim().min(1).optional().nullable().default(null),
    path: z
      .string()
      .trim()
      .min(1)
      .optional()
      .nullable()
      .transform((value) => {
        if (!value) return null;
        return value.startsWith("/") ? value : `/${value}`;
      }),
    methods: z.array(z.string().trim().toUpperCase()).optional(),
    headers: headersSchema,
    hooks: hooksSchema,
  })
  .transform<ProxyForwardConfig>((forward) => ({
    ...forward,
    methods:
      forward.methods && forward.methods.length > 0 ? Array.from(new Set(forward.methods)) : ["*"],
  }));

export const proxyInstanceSettingsSchema = z
  .object({
    autoSortSameNameForwards: z.boolean().default(false),
    autoPushConfig: z.boolean().default(true),
  })
  .optional()
  .nullable();

export const proxyInstanceSchema = z
  .object({
    name: z.string().min(1).trim(),
    port: z.number().int().min(1).max(65535),
    enabled: z.boolean().default(true),
    description: z.string().trim().min(1).optional().nullable().default(null),
    headers: headersSchema,
    hooks: hooksSchema,
    forwards: z.array(proxyForwardSchema).default([]),
    settings: proxyInstanceSettingsSchema,
  })
  .transform<ProxyInstanceConfig>((instance) => ({
    ...instance,
    forwards: instance.forwards ?? [],
    settings: instance.settings ?? null,
  }));

export const proxyGlobalSettingsSchema = z
  .preprocess(
    (value) => (value == null ? undefined : value),
    z
      .object({
        frontendAutoPullConfig: z.boolean().default(true),
        dbPath: z.string().default(DEFAULT_DB_PATH_TEMPLATE),
      })
      .default({ frontendAutoPullConfig: true, dbPath: DEFAULT_DB_PATH_TEMPLATE }),
  );

export const proxyConfigSchema = z
  .object({
    settings: proxyGlobalSettingsSchema,
    instances: z.array(proxyInstanceSchema).default([]),
  })
  .transform<ProxyConfigFile>((config) => ({
    settings: config.settings,
    instances: config.instances,
  }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfigFile(content: string): ProxyConfigFile {
  const parsed: unknown = JSON.parse(content);

  // 兼容一次性迁移：autoWatchConfig -> frontendAutoPullConfig
  if (isRecord(parsed) && isRecord(parsed.settings)) {
    const settings = parsed.settings;
    if (
      typeof settings.frontendAutoPullConfig !== "boolean" &&
      typeof settings.autoWatchConfig === "boolean"
    ) {
      settings.frontendAutoPullConfig = settings.autoWatchConfig;
    }
    delete settings.autoWatchConfig;
  }
  return proxyConfigSchema.parse(parsed);
}

export function serializeConfigFile(config: ProxyConfigFile): string {
  return JSON.stringify(config, null, 2);
}
