/**
 * Envelope 编解码工具
 *
 * 协议格式: head-len(uint32be) + JSON meta + raw body
 */

const HEAD_LEN_BYTES = 4;

/**
 * 编码 envelope
 */
export function encodeEnvelope(meta: unknown, body: Uint8Array): Buffer {
  const metaBuffer = Buffer.from(JSON.stringify(meta ?? {}), "utf-8");
  const lenBuffer = Buffer.alloc(HEAD_LEN_BYTES);
  lenBuffer.writeUInt32BE(metaBuffer.length, 0);
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([lenBuffer, metaBuffer, bodyBuffer]);
}

/**
 * 解码 envelope
 */
export function decodeEnvelope(buffer: Buffer): { meta: unknown; body: Buffer } {
  if (buffer.length < HEAD_LEN_BYTES) {
    throw new Error("Invalid envelope: missing head-len");
  }
  const headLen = buffer.readUInt32BE(0);
  if (buffer.length < HEAD_LEN_BYTES + headLen) {
    throw new Error("Invalid envelope: head-len mismatch");
  }
  const metaBuffer = buffer.subarray(HEAD_LEN_BYTES, HEAD_LEN_BYTES + headLen);
  const body = buffer.subarray(HEAD_LEN_BYTES + headLen);
  const metaJson = metaBuffer.toString("utf-8") || "{}";
  return { meta: JSON.parse(metaJson), body };
}
