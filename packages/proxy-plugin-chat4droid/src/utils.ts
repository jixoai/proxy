export function safeJsonStringify(value: unknown, fallback = "{}"): string {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

export function safeJsonParse<T = unknown>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function joinNonEmpty(parts: string[], sep: string): string {
  return parts.map((s) => s.trim()).filter(Boolean).join(sep);
}

export function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function generateId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `${prefix}${rand}`;
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
