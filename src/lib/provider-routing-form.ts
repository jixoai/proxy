import type { ApiFormat, ModelRouting } from "../types/proxy";
import { optionalModelRoutingSchema } from "./provider-routing-config";

export interface ModelRoutingRow {
  key: string;
  name: string;
  aliases: string;
  apiFormats: ApiFormat[];
}

export interface ModelRoutingDraft {
  mode: "all" | "listed";
  models: ModelRoutingRow[];
}

export function createModelRoutingDraft(routing?: ModelRouting | null): ModelRoutingDraft {
  return {
    mode: routing?.mode ?? "all",
    models: (routing?.models ?? []).map((entry) => ({
      key: crypto.randomUUID(),
      name: entry.name,
      aliases: entry.aliases?.join(", ") ?? "",
      apiFormats: [...(entry.apiFormats ?? [])],
    })),
  };
}

export function parseModelRoutingDraft(draft: ModelRoutingDraft): ModelRouting | null {
  return optionalModelRoutingSchema.parse({
    mode: draft.mode,
    models: draft.models.map((entry) => ({
      name: entry.name,
      aliases: entry.aliases
        .split(/[,，\n]/)
        .map((alias) => alias.trim())
        .filter(Boolean),
      apiFormats: entry.apiFormats,
    })),
  });
}
