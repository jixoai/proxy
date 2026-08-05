import { Buffer } from "node:buffer";

export type StreamUtils = {
  streamFromBuffer: typeof streamFromBuffer;
  readStreamToBuffer: typeof readStreamToBuffer;
  readStreamToText: typeof readStreamToText;
  teeStream: typeof teeStream;
};

export function streamFromBuffer(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

export async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Buffer.from(out as unknown as ArrayBuffer);
  } finally {
    reader.releaseLock();
  }
}

export async function readStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const buffer = await readStreamToBuffer(stream);
  return buffer.toString("utf-8");
}

export function teeStream(
  stream: ReadableStream<Uint8Array>,
): { left: ReadableStream<Uint8Array>; right: ReadableStream<Uint8Array> } {
  const [left, right] = stream.tee();
  return { left, right };
}
