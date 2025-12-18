/**
 * 工具函数
 */

/**
 * 判断是否为 Record 对象
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 标准化 headers（将数组转为逗号分隔的字符串）
 */
export function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!isRecord(headers)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (typeof value === "string") {
      result[normalizedKey] = value;
    } else if (Array.isArray(value)) {
      result[normalizedKey] = value.map(String).join(", ");
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * 判断是否为 JSON Content-Type
 */
export function isJsonContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes("application/json") || normalized.includes("+json");
}

/**
 * 判断是否为 Event Stream Content-Type
 */
export function isEventStreamContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes("text/event-stream");
}

/**
 * 安全解析 JSON
 */
export function safeParseJson<T = unknown>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}
