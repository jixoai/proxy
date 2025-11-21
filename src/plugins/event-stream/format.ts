const utf8Decoder = new TextDecoder("utf-8");

export function formatIntermediateValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    try {
      return utf8Decoder.decode(value);
    } catch {
      return `Uint8Array(${value.length})`;
    }
  }
  if (value instanceof ArrayBuffer) {
    return formatIntermediateValue(new Uint8Array(value));
  }
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
