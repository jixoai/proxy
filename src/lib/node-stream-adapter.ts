import type * as http from "node:http";
import type { Readable } from "node:stream";

export function nodeReadableToWebStream(readable: Readable | http.IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        controller.enqueue(new Uint8Array(buf));
      };
      const onEnd = () => controller.close();
      const onError = (err: unknown) => controller.error(err);

      readable.on("data", onData);
      readable.on("end", onEnd);
      readable.on("error", onError);
    },
    cancel(reason) {
      readable.destroy(reason instanceof Error ? reason : undefined);
    },
  });
}

export async function pipeWebStreamToNodeResponse(params: {
  stream: ReadableStream<Uint8Array>;
  res: http.ServerResponse;
  onChunk?: (chunk: Uint8Array) => void;
}): Promise<void> {
  const reader = params.stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      params.onChunk?.(value);
      const ok = params.res.write(Buffer.from(value));
      if (!ok) {
        await new Promise<void>((resolve) => params.res.once("drain", resolve));
      }
    }
  } finally {
    reader.releaseLock();
    if (!params.res.writableEnded) {
      params.res.end();
    }
  }
}
