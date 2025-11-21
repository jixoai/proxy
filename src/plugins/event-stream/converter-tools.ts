import { createHighlightTag } from "@/lib/highlighter";
import type {
  BuiltInConverterId,
  ConverterEditorState,
  ConverterInstance,
  EventStreamMessage,
} from "./types";

const utf8Decoder = new TextDecoder("utf-8");
export const JSONHighlighterTag = createHighlightTag("json");

export function ensureString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof (value as any).toString === "function") {
    try {
      return (value as any).toString();
    } catch {
      // fallthrough
    }
  }
  if (value instanceof Uint8Array) {
    try {
      return utf8Decoder.decode(value);
    } catch {
      return null;
    }
  }
  if (value instanceof ArrayBuffer) {
    return ensureString(new Uint8Array(value));
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function decodeBase64(text: string) {
  const normalized = text.replace(/\s+/g, "");
  const binary = atob(normalized);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)!;
  }
  return utf8Decoder.decode(bytes);
}

export async function runBuiltInConverter(
  id: BuiltInConverterId,
  input: unknown,
) {
  switch (id) {
    case "auto": {
      const str = ensureString(input);
      let candidate: unknown = input;
      if (typeof str === "string" && str.length > 0) {
        try {
          candidate = decodeBase64(str);
        } catch {
          candidate = input;
        }
      }
      const next = ensureString(candidate) ?? "";
      try {
        const parsed = JSON.parse(next);
        const formatted = JSON.stringify(parsed, null, 2);
        return JSONHighlighterTag`${formatted}`;
      } catch {
        return candidate;
      }
    }
    case "base64": {
      const str = ensureString(input);
      if (str === null)
        throw new Error("Base64 converter requires string input");
      return decodeBase64(str);
    }
    case "json": {
      const str = ensureString(input);
      if (str === null) throw new Error("JSON converter requires string input");
      const parsed = JSON.parse(str);
      const formatted = JSON.stringify(parsed, null, 2);
      return JSONHighlighterTag`${formatted}`;
    }
    default:
      return input;
  }
}

export function prepareJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const customModuleCache = new Map<
  string,
  {
    source: string;
    transformer: (text: string, json: any, ctx: any) => unknown;
  }
>();

const HIGHLIGHTER_IMPORT_SNIPPET = `
const __origin = globalThis.location && globalThis.location.origin ? globalThis.location.origin : "";
const __moduleURL = new URL("/standalone/highlighter-inline.ts", __origin || undefined);
const { JSON, TEXT, RAW, HTML, html, createHighlightTag, createTextTag } = await import(__moduleURL.href);
`;

function buildCustomModuleSource(instance: ConverterInstance) {
  const userCode =
    instance.kind === "custom-expression"
      ? `export async function transform(text, json, context) { return (${instance.expression}); }`
      : instance.kind === "custom-function"
        ? instance.source
        : "";
  return `${HIGHLIGHTER_IMPORT_SNIPPET}\n${userCode}`;
}

export async function loadCustomModule(instance: ConverterInstance) {
  const source = buildCustomModuleSource(instance);
  if (!source) return null;
  const cached = customModuleCache.get(instance.instanceId);
  if (cached && cached.source === source) return cached.transformer;

  const blob = new Blob([source], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const module = await import(/* @vite-ignore */ url);
    if (typeof module.transform !== "function") {
      throw new Error(
        "Custom module must export function transform(text, json, context)",
      );
    }
    const transformer = module.transform as (
      text: string,
      json: any,
      ctx: any,
    ) => unknown;
    customModuleCache.set(instance.instanceId, { source, transformer });
    return transformer;
  } finally {
    URL.revokeObjectURL(url);
  }
}
