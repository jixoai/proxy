import { z } from "zod";
import type {
  ProxyConfigFile,
  ProxyForwardConfig,
  ProxyInstanceConfig,
  HooksConfig,
} from "../types/proxy";

const stdioHookSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
});

const hookConfigSchema = stdioHookSchema;

const hooksSchema = z
  .object({
    request: hookConfigSchema.optional().nullable(),
    response: hookConfigSchema.optional().nullable(),
  })
  .optional()
  .nullable()
  .transform<HooksConfig | null>((value) => {
    if (!value) return null;
    if (!value.request && !value.response) return null;
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
      forward.methods && forward.methods.length > 0
        ? Array.from(new Set(forward.methods))
        : ["*"],
  }));

export const proxyInstanceSchema = z
  .object({
    name: z.string().min(1).trim(),
    port: z.number().int().min(1).max(65535),
    enabled: z.boolean().default(true),
    description: z.string().trim().min(1).optional().nullable().default(null),
    headers: headersSchema,
    hooks: hooksSchema,
    forwards: z.array(proxyForwardSchema).default([]),
  })
  .transform<ProxyInstanceConfig>((instance) => ({
    ...instance,
    forwards: instance.forwards ?? [],
  }));

export const proxyConfigSchema = z
  .object({
    instances: z.array(proxyInstanceSchema).default([]),
  })
  .transform<ProxyConfigFile>((config) => ({
    instances: config.instances,
  }));

export function parseConfigFile(content: string): ProxyConfigFile {
  const parsed = JSON.parse(content);
  return proxyConfigSchema.parse(parsed);
}

export function serializeConfigFile(config: ProxyConfigFile): string {
  return JSON.stringify(config, null, 2);
}
