import {
  parsePluginUiHeaders,
  type PluginUiMap,
  type PluginUiPayload,
  PLUGIN_UI_HEADER_PREFIX,
  PLUGIN_UI_STREAM_SUFFIX,
} from "@jixo/proxy-plugin";

export type PluginUiPayloadResolved = {
  name: string;
  tray: Array<{ icon: string; description?: string }>;
  remark?: string;
};

export type PluginUiRecord = {
  name: string;
  payload?: PluginUiPayloadResolved;
  streamUrl?: string;
  source: "request" | "response";
};

export type PluginUiParseResult = {
  records: PluginUiRecord[];
  order: string[];
};

const MAX_TRAY_ITEMS = 3;
const MAX_DESCRIPTION_LENGTH = 200;

function normalizePayload(name: string, payload: PluginUiPayload | undefined): PluginUiPayloadResolved | undefined {
  if (!payload) return undefined;
  const tray = Array.isArray(payload.tray) ? payload.tray.slice(0, MAX_TRAY_ITEMS) : [];
  return {
    name: payload.name?.trim() || name,
    tray: tray
      .filter((item) => item && typeof item.icon === "string" && item.icon.trim().length > 0)
      .map((item) => ({
        icon: item.icon,
        description: item.description ? trimDescription(item.description) : undefined,
      })),
    remark: payload.remark?.trim() || undefined,
  };
}

function trimDescription(text: string): string {
  const singleLine = text.replace(/\r?\n/g, " ").trim();
  if (singleLine.length <= MAX_DESCRIPTION_LENGTH) return singleLine;
  return `${singleLine.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
}

function mergePluginUiMap(
  map: PluginUiMap | undefined,
  source: "request" | "response",
): PluginUiRecord[] {
  if (!map) return [];
  return Object.entries(map).map(([name, data]) => ({
    name,
    payload: normalizePayload(name, data.payload),
    streamUrl: data.streamUrl,
    source,
  }));
}

export function parsePluginUiFromHeaders(
  requestHeaders: Record<string, string | string[]> | undefined,
  responseHeaders: Record<string, string | string[]> | undefined,
  pluginsProcessed: string[] | undefined,
): PluginUiParseResult | undefined {
  const requestMap = parsePluginUiHeaders(requestHeaders);
  const responseMap = parsePluginUiHeaders(responseHeaders);

  const requestRecords = mergePluginUiMap(requestMap, "request");
  const responseRecords = mergePluginUiMap(responseMap, "response");

  if (requestRecords.length === 0 && responseRecords.length === 0) return undefined;

  const merged = new Map<string, PluginUiRecord>();
  for (const record of requestRecords) {
    merged.set(record.name, record);
  }
  for (const record of responseRecords) {
    merged.set(record.name, record);
  }

  const order = Array.isArray(pluginsProcessed) ? pluginsProcessed.slice() : [];
  for (const name of merged.keys()) {
    if (!order.includes(name)) order.push(name);
  }

  const records = order
    .map((name) => merged.get(name))
    .filter((record): record is PluginUiRecord => !!record);

  return { records, order };
}

export function sanitizePluginUiPayload(input: PluginUiPayloadResolved): PluginUiPayloadResolved {
  const name = input.name.trim();
  const tray = (input.tray ?? []).slice(0, MAX_TRAY_ITEMS).map((item) => ({
    icon: item.icon,
    description: item.description ? trimDescription(item.description) : undefined,
  }));
  const remark = input.remark ? input.remark.trim() : undefined;
  return { name, tray, remark };
}

export function getPluginUiHeaderPrefix(): string {
  return PLUGIN_UI_HEADER_PREFIX;
}

export function getPluginUiStreamSuffix(): string {
  return PLUGIN_UI_STREAM_SUFFIX;
}

export function buildPluginUiTooltipMarkdown(records: PluginUiRecord[]): string {
  return records
    .map((record) => {
      const lines: string[] = [];
      lines.push(`## ${record.payload?.name ?? record.name}`);
      const tray = record.payload?.tray ?? [];
      for (const item of tray) {
        lines.push(`- ${item.icon}: ${item.description ?? ""}`.trimEnd());
      }
      if (record.payload?.remark) {
        lines.push("");
        lines.push(record.payload.remark);
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

export function getTrayItems(records: PluginUiRecord[]): Array<{ icon: string; description?: string }> {
  const items: Array<{ icon: string; description?: string }> = [];
  for (const record of records) {
    const tray = record.payload?.tray ?? [];
    for (const item of tray) {
      items.push(item);
      if (items.length >= MAX_TRAY_ITEMS) return items;
    }
  }
  return items;
}
