import { z } from "zod";
import type { ProviderRoutingConfig } from "../types/proxy";

export const API_FORMAT_LABELS = {
  responses: "Responses",
  "anthropic-messages": "Anthropic Messages",
  "chat-completions": "Chat Completions",
} as const;

const modelNameSchema = z.string().trim().min(1, "模型名称不能为空");
const apiFormatsSchema = z
  .array(z.enum(["responses", "anthropic-messages", "chat-completions"]))
  .transform((formats) => [...new Set(formats)]);

export const providerRoutingSchema = z.object({
  models: z
    .array(modelNameSchema)
    .nullish()
    .transform((models) => (models?.length ? [...new Set(models)] : undefined)),
  modelMapping: z
    .record(modelNameSchema, modelNameSchema)
    .nullish()
    .transform((mapping) => (mapping && Object.keys(mapping).length ? mapping : undefined)),
  apiFormats: apiFormatsSchema
    .nullish()
    .transform((formats) => (formats?.length ? formats : undefined)),
  modelApiFormats: z
    .record(modelNameSchema, apiFormatsSchema)
    .nullish()
    .transform((formats) => {
      const entries = Object.entries(formats ?? {}).filter(([, values]) => values.length);
      return entries.length ? Object.fromEntries(entries) : undefined;
    }),
});

export function getProviderRoutingConfig(config: ProviderRoutingConfig): ProviderRoutingConfig {
  return {
    models: config.models ?? null,
    modelMapping: config.modelMapping ?? null,
    apiFormats: config.apiFormats ?? null,
    modelApiFormats: config.modelApiFormats ?? null,
  };
}
