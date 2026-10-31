import type * as http from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export function nodeReadableToWebStream(
  readable: Readable | http.IncomingMessage,
): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>;
}

export async function pipeWebStreamToNodeResponse(params: {
  stream: ReadableStream<Uint8Array>;
  res: http.ServerResponse;
  onChunk?: (chunk: Uint8Array) => void;
}): Promise<void> {
  await pipeline(
    Readable.fromWeb(params.stream as unknown as NodeReadableStream),
    new Transform({
      transform(chunk, _encoding, callback) {
        try {
          params.onChunk?.(chunk);
          callback(null, chunk);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    }),
    params.res,
  );
}
