import { Buffer } from "node:buffer";

const DEFAULT_MIME = "application/octet-stream";

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fromBase64Url(data: string): Buffer {
  const base64 = data
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(data.length / 4) * 4, "=");
  return Buffer.from(base64, "base64");
}

export function bufferToDataUrl(buffer: Buffer, mime?: string | null): string {
  const mediaType = (mime && mime.split(";")[0]) || DEFAULT_MIME;
  const encoded = toBase64Url(buffer);
  return `data:${mediaType};base64,${encoded}`;
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

export function ensureDataUrl(
  input: string | Buffer | Uint8Array | null | undefined,
  mime?: string | null,
): string | null {
  if (input == null) {
    return null;
  }

  if (typeof input === "string") {
    return isDataUrl(input)
      ? input
      : bufferToDataUrl(Buffer.from(input, "utf-8"), mime || "text/plain");
  }

  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return bufferToDataUrl(buffer, mime);
}

export function dataUrlToBuffer(dataUrl: string): {
  mime: string;
  buffer: Buffer;
} {
  if (!isDataUrl(dataUrl)) {
    throw new Error("Invalid data URL");
  }

  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) {
    throw new Error("Malformed data URL");
  }

  const mime = match[1] || DEFAULT_MIME;
  const base64Flag = match[2];
  const data = match[3] ?? "";
  if (base64Flag) {
    return { mime, buffer: fromBase64Url(data) };
  }

  return { mime, buffer: Buffer.from(decodeURIComponent(data), "utf-8") };
}

export function extractDataUrl(dataUrl: string): {
  mime: string;
  encoding: "base64" | "text";
  data: string;
} {
  if (!isDataUrl(dataUrl)) {
    throw new Error("Invalid data URL");
  }

  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) {
    throw new Error("Malformed data URL");
  }

  const mime = match[1] || DEFAULT_MIME;
  const base64Flag = match[2];
  const payload = match[3] ?? "";
  if (base64Flag) {
    return { mime, encoding: "base64", data: payload }; // payload already base64url
  }
  return { mime, encoding: "text", data: payload };
}

export function base64UrlToBase64(data: string): string {
  return data
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(data.length / 4) * 4, "=");
}

/**
 * 解析 data URL 为结构化对象（浏览器端兼容）
 */
export interface ParsedDataUrl {
  mime: string;
  isBase64: boolean;
  data: string;
}

export function parseDataUrl(value: string): ParsedDataUrl | null {
  if (!isDataUrl(value)) return null;
  const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;
  const [, mime = DEFAULT_MIME, base64Flag, data = ""] = match;
  return {
    mime,
    isBase64: Boolean(base64Flag),
    data,
  };
}

/**
 * 将 data URL 解码为字符串（浏览器端兼容）
 */
export function decodeDataUrlToString(value: string): string {
  const parsed = parseDataUrl(value);
  if (!parsed) {
    return value;
  }
  if (!parsed.isBase64) {
    return decodeURIComponent(parsed.data);
  }
  const base64 = base64UrlToBase64(parsed.data);
  const buffer = fromBase64Url(parsed.data);
  return buffer.toString("utf-8");
}

/**
 * 从 data URL 提取 base64 数据（浏览器端兼容）
 */
export function dataUrlToBase64(value: string): string | null {
  const parsed = parseDataUrl(value);
  if (!parsed || !parsed.isBase64) {
    return null;
  }
  return base64UrlToBase64(parsed.data);
}

/**
 * 将 data URL 转换为 Uint8Array（浏览器端兼容）
 * 用于在浏览器中解码 data URL，不依赖 fetch API
 */
export function dataUrlToUint8Array(value: string): Uint8Array | null {
  const parsed = parseDataUrl(value);
  if (!parsed) {
    return null;
  }

  if (!parsed.isBase64) {
    // 文本数据，使用 TextEncoder
    const decodedText = decodeURIComponent(parsed.data);
    return new TextEncoder().encode(decodedText);
  }

  // Base64 数据，手动解码
  const base64 = base64UrlToBase64(parsed.data);
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
