import type { ApiFormat, ModelRoutingEntry, ProviderRoutingConfig } from "../types/proxy";

export interface ModelRequest {
  model: string | null;
  apiFormat: ApiFormat | null;
  requiresModel: boolean;
  invalidJson: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function identifyApiFormat(pathname: string, prefix?: string | null): ApiFormat | null {
  const paths = [pathname];
  const normalizedPrefix = prefix?.replace(/\/+$/, "");
  if (normalizedPrefix && pathname.startsWith(normalizedPrefix))
    paths.unshift(pathname.slice(normalizedPrefix.length));
  const versionedPathIndex = pathname.lastIndexOf("/v1/");
  if (versionedPathIndex > 0) paths.push(pathname.slice(versionedPathIndex));
  for (const path of paths) {
    if (/^\/(?:v1\/)?responses(?:\/compact)?\/?$/.test(path)) return "responses";
    if (/^\/(?:v1\/)?messages(?:\/count_tokens)?\/?$/.test(path)) return "anthropic-messages";
    if (/^\/(?:v1\/)?chat\/completions\/?$/.test(path)) return "chat-completions";
  }
  return null;
}

export function inspectModelRequest(
  body: Buffer,
  method: string,
  pathname: string,
  prefix?: string | null,
): ModelRequest {
  const apiFormat = identifyApiFormat(pathname, prefix);
  let payload: unknown;
  let invalidJson = false;
  if (body.length) {
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      invalidJson = true;
    }
  }
  const model =
    isRecord(payload) && typeof payload.model === "string" && payload.model.trim()
      ? payload.model
      : null;
  return {
    model,
    apiFormat,
    requiresModel:
      method !== "GET" &&
      method !== "HEAD" &&
      (apiFormat !== null || (isRecord(payload) && Object.hasOwn(payload, "model"))),
    invalidJson,
  };
}

export function resolveProviderModel(
  config: ProviderRoutingConfig,
  original: string | null,
): string | null {
  if (original === null) return null;
  return findProviderModel(config, original)?.name ?? original;
}

export function findProviderModel(
  config: ProviderRoutingConfig,
  model: string | null,
): ModelRoutingEntry | undefined {
  return model === null
    ? undefined
    : config.modelRouting?.models.find(
        (entry) => entry.name === model || entry.aliases?.includes(model),
      );
}

export function hasProviderModelAlias(
  config: ProviderRoutingConfig,
  model: string | null,
): boolean {
  const entry = findProviderModel(config, model);
  return Boolean(entry && entry.name !== model);
}

export function providerIncompatibility(
  config: ProviderRoutingConfig,
  request: ModelRequest,
  model: string | null,
  deferModel = false,
): "api_not_supported" | "model_not_supported" | "missing_model" | null {
  const format = request.apiFormat;
  if (deferModel) return null;
  const entry = config.modelRouting?.models.find((entry) => entry.name === model);
  if (request.requiresModel && config.modelRouting?.mode === "listed") {
    if (model === null) return "missing_model";
    if (!entry) return "model_not_supported";
  }
  const formats = entry?.apiFormats;
  if (format && formats?.length && !formats.includes(format)) return "api_not_supported";
  return null;
}

export function rewriteRequestModel(body: Buffer, model: string): Buffer {
  const payload: unknown = JSON.parse(body.toString("utf8"));
  if (!isRecord(payload)) throw new Error("Model mapping requires a JSON object");
  return payload.model === model ? body : Buffer.from(JSON.stringify({ ...payload, model }));
}

export function hasProviderRouting(config: ProviderRoutingConfig): boolean {
  return Boolean(config.modelRouting?.mode === "listed" || config.modelRouting?.models.length);
}
