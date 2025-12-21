import { PrivateHeaders } from "./private-headers";

export const PLUGIN_UI_HEADER_PREFIX = "-x-jixo-proxy-";
export const PLUGIN_UI_STREAM_SUFFIX = "-stream";

export type PluginTrayItem = {
  icon: string;
  description?: string;
};

export type PluginUiPayload = {
  name?: string;
  tray?: PluginTrayItem[];
  remark?: string;
};

export type PluginUiData = {
  payload?: PluginUiPayload;
  streamUrl?: string;
};

export type PluginUiMap = Record<string, PluginUiData>;

const reservedPrivateHeaders = new Set(
  Object.values(PrivateHeaders).map((value) => value.toLowerCase()),
);

const reservedPluginNames = new Set(
  Object.values(PrivateHeaders)
    .map((value) => value.toLowerCase())
    .filter((value) => value.startsWith(PLUGIN_UI_HEADER_PREFIX))
    .map((value) => value.slice(PLUGIN_UI_HEADER_PREFIX.length)),
);

function isReservedPrivateHeader(key: string): boolean {
  return reservedPrivateHeaders.has(key.toLowerCase());
}

function isReservedPluginName(name: string): boolean {
  return reservedPluginNames.has(name.toLowerCase());
}

export function isPluginUiHeader(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith(PLUGIN_UI_HEADER_PREFIX) && !isReservedPrivateHeader(lower);
}

export function getPluginNameFromHeader(key: string): string | null {
  const lower = key.toLowerCase();
  if (!lower.startsWith(PLUGIN_UI_HEADER_PREFIX)) return null;
  if (isReservedPrivateHeader(lower)) return null;
  const remainder = lower.slice(PLUGIN_UI_HEADER_PREFIX.length);
  if (!remainder) return null;
  if (remainder.endsWith(PLUGIN_UI_STREAM_SUFFIX)) {
    const name = remainder.slice(0, -PLUGIN_UI_STREAM_SUFFIX.length) || null;
    if (!name || isReservedPluginName(name)) return null;
    return name;
  }
  if (isReservedPluginName(remainder)) return null;
  return remainder;
}

export function isPluginUiStreamHeader(key: string): boolean {
  const lower = key.toLowerCase();
  if (!lower.startsWith(PLUGIN_UI_HEADER_PREFIX)) return false;
  if (!lower.endsWith(PLUGIN_UI_STREAM_SUFFIX)) return false;
  const name = lower.slice(PLUGIN_UI_HEADER_PREFIX.length, -PLUGIN_UI_STREAM_SUFFIX.length);
  return !isReservedPrivateHeader(lower) && !isReservedPluginName(name);
}

export function parsePluginUiHeaders(
  headers: Record<string, string | string[]> | undefined,
): PluginUiMap | undefined {
  if (!headers) return undefined;

  const entries = Object.entries(headers);
  const result: PluginUiMap = {};

  for (const [rawKey, rawValue] of entries) {
    if (!rawKey) continue;
    const key = rawKey.toLowerCase();
    if (!isPluginUiHeader(key)) continue;

    const pluginName = getPluginNameFromHeader(key);
    if (!pluginName) continue;

    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (!value) continue;

    const existing = result[pluginName] ?? {};

    if (isPluginUiStreamHeader(key)) {
      existing.streamUrl = value;
      result[pluginName] = existing;
      continue;
    }

    try {
      const payload = JSON.parse(value) as PluginUiPayload;
      existing.payload = payload;
      result[pluginName] = existing;
    } catch {
      // ignore invalid JSON
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function buildPluginUiHeaderKey(pluginName: string): string {
  return `${PLUGIN_UI_HEADER_PREFIX}${pluginName}`;
}

export function buildPluginUiStreamHeaderKey(pluginName: string): string {
  return `${PLUGIN_UI_HEADER_PREFIX}${pluginName}${PLUGIN_UI_STREAM_SUFFIX}`;
}
