import type { ApiFormat, ProviderRoutingConfig } from "../types/proxy";
import { providerRoutingSchema } from "./provider-routing-config";

export interface ProviderRoutingDraft {
  models: string[];
  mappings: { from: string; to: string }[];
  apiFormats: ApiFormat[];
  modelApis: { model: string; formats: ApiFormat[] }[];
}

export function createProviderRoutingDraft(
  config: ProviderRoutingConfig = {},
): ProviderRoutingDraft {
  return {
    models: [...(config.models ?? [])],
    mappings: Object.entries(config.modelMapping ?? {}).map(([from, to]) => ({ from, to })),
    apiFormats: [...(config.apiFormats ?? [])],
    modelApis: Object.entries(config.modelApiFormats ?? {}).map(([model, formats]) => ({
      model,
      formats: [...formats],
    })),
  };
}

export function parseProviderRoutingDraft(draft: ProviderRoutingDraft): ProviderRoutingConfig {
  const mappings = draft.mappings.filter((row) => row.from.trim() || row.to.trim());
  if (mappings.some((row) => !row.from.trim() || !row.to.trim()))
    throw new Error("模型映射需要同时填写客户端名称和目标名称");
  if (new Set(mappings.map((row) => row.from.trim())).size !== mappings.length)
    throw new Error("客户端模型名称不能重复映射");
  const modelApis = draft.modelApis.filter((row) => row.model.trim() || row.formats.length);
  if (modelApis.some((row) => !row.model.trim()))
    throw new Error("请为模型 API 限制填写目标模型名称");
  if (new Set(modelApis.map((row) => row.model.trim())).size !== modelApis.length)
    throw new Error("同一目标模型的 API 限制不能重复配置");
  return providerRoutingSchema.parse({
    models: draft.models.map((model) => model.trim()).filter(Boolean),
    modelMapping: Object.fromEntries(mappings.map((row) => [row.from.trim(), row.to.trim()])),
    apiFormats: draft.apiFormats,
    modelApiFormats: Object.fromEntries(modelApis.map((row) => [row.model.trim(), row.formats])),
  });
}
