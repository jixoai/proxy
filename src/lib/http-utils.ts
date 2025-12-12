/**
 * HTTP 相关工具函数
 * 集中管理 Content-Type 提取和 MIME 类型判断
 */

/**
 * 从 JSON 格式的 headers 中提取 Content-Type
 * @param headersJson JSON 字符串格式的 headers
 * @returns Content-Type 值，如果不存在则返回 null
 */
export function extractContentTypeFromJson(headersJson: string | null | undefined): string | null {
  if (!headersJson) return null;
  try {
    const headers = JSON.parse(headersJson) as Record<string, unknown>;
    return extractContentTypeFromHeaders(headers);
  } catch {
    return null;
  }
}

/**
 * 从 headers 对象中提取 Content-Type（大小写不敏感）
 * @param headers Headers 对象
 * @returns Content-Type 值，如果不存在则返回 null
 */
export function extractContentTypeFromHeaders(headers: Record<string, unknown>): string | null {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-type") {
      const value = headers[key];
      // 处理数组格式（某些 HTTP 库会将 header 值存为数组）
      return Array.isArray(value) ? value[0] : String(value);
    }
  }
  return null;
}

/**
 * 判断 MIME 类型是否看起来像文本类型
 * @param mime MIME 类型字符串
 * @returns 如果是文本类型返回 true
 */
export function isTextLikeMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const lower = mime.toLowerCase();
  return (
    lower.startsWith("text/") ||
    lower.includes("json") ||
    lower.includes("xml") ||
    lower.includes("javascript") ||
    lower.includes("form")
  );
}

/**
 * 从完整的 Content-Type 中提取纯 MIME 类型（去除参数）
 * 例如: "text/html; charset=utf-8" -> "text/html"
 * @param contentType 完整的 Content-Type 字符串
 * @returns 纯 MIME 类型
 */
export function extractMimeType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  return contentType.split(";")[0]?.trim() || null;
}
