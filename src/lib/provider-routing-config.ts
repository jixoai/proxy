import { z } from "zod";
import type { ModelRouting, ProviderRoutingConfig } from "../types/proxy";

export const API_FORMAT_LABELS = {
  responses: "Responses",
  "anthropic-messages": "Anthropic Messages",
  "chat-completions": "Chat Completions",
} as const;

const modelNameSchema = z.string().trim().min(1, "模型名称不能为空");
const modelEntrySchema = z
  .object({
    name: modelNameSchema,
    aliases: z
      .array(modelNameSchema)
      .nullish()
      .transform((aliases) => [...new Set(aliases ?? [])]),
    apiFormats: z
      .array(z.enum(["responses", "anthropic-messages", "chat-completions"]))
      .nullish()
      .transform((formats) => [...new Set(formats ?? [])].sort()),
  })
  .strict()
  .transform((entry) => ({
    ...entry,
    aliases: entry.aliases.filter((alias) => alias !== entry.name),
  }));

export const modelRoutingSchema = z
  .object({
    mode: z.enum(["all", "listed"]).default("all"),
    models: z.array(modelEntrySchema).default([]),
  })
  .strict()
  .superRefine((routing, context) => {
    if (routing.mode === "listed" && !routing.models.length) {
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "仅表内模型模式至少需要一个模型；如需全部支持，请切换为全部模型",
      });
    }
    const owners = new Map<string, number>();
    routing.models.forEach((entry, index) => {
      [entry.name, ...entry.aliases].forEach((name, nameIndex) => {
        if (owners.has(name)) {
          context.addIssue({
            code: "custom",
            path: ["models", index, nameIndex ? "aliases" : "name"],
            message: `模型名称或别名“${name}”与其他模型重复`,
          });
        } else owners.set(name, index);
      });
    });
  })
  .transform<ModelRouting | null>((routing) =>
    routing.mode === "all" && !routing.models.length ? null : routing,
  );

export const optionalModelRoutingSchema = modelRoutingSchema
  .nullish()
  .transform((value) => value ?? null);
const removedFieldSchema = z
  .never({
    error:
      "旧模型字段已移除，请将模型、别名和 API 合并到 modelRouting.models；参见 docs/provider-model-routing.md",
  })
  .optional();

export const providerRoutingSchema = z.object({
  modelRouting: optionalModelRoutingSchema,
  models: removedFieldSchema,
  modelMapping: removedFieldSchema,
  apiFormats: removedFieldSchema,
  modelApiFormats: removedFieldSchema,
});

export function getProviderRoutingConfig(config: ProviderRoutingConfig): ProviderRoutingConfig {
  return { modelRouting: config.modelRouting ?? null };
}

export function modelRoutingFingerprint(value: ModelRouting | null | undefined): string {
  return JSON.stringify(optionalModelRoutingSchema.parse(value));
}
