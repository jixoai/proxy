import { describe, expect, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import {
  nodeReadableToWebStream,
  pipeWebStreamToNodeResponse,
} from "../src/lib/node-stream-adapter";

async function outcome(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(
      () => "completed",
      () => "failed",
    ),
    Bun.sleep(200).then(() => "pending"),
  ]);
}

describe("Node/Web stream lifecycle", () => {
  test("a premature upstream close rejects instead of leaving a pending read", async () => {
    const source = new Readable({ read() {} });
    const reader = nodeReadableToWebStream(source).getReader();
    const pending = reader.read();
    source.destroy();
    expect(await outcome(pending)).toBe("failed");
  });

  test("stops reading upstream when the web consumer stops draining", async () => {
    const source = new Readable({ read() {} });
    const stream = nodeReadableToWebStream(source);
    source.push(Buffer.alloc(64 * 1024));
    await Bun.sleep(20);
    expect(source.readableFlowing).not.toBe(true);
    await stream.cancel();
    expect(source.destroyed).toBe(true);
  });

  test("downstream close cancels a stalled upstream read", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const pending = pipeWebStreamToNodeResponse({
      stream,
      res: destination as unknown as ServerResponse,
    });
    await Bun.sleep(10);
    destination.destroy();
    expect(await outcome(pending)).toBe("failed");
    expect(canceled).toBe(true);
  });

  test("downstream close while backpressured does not wait forever for drain", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        canceled = true;
      },
    });
    const destination = new Writable({ highWaterMark: 1, write() {} });
    const pending = pipeWebStreamToNodeResponse({
      stream,
      res: destination as unknown as ServerResponse,
    });
    await Bun.sleep(10);
    destination.destroy();
    expect(await outcome(pending)).toBe("failed");
    expect(canceled).toBe(true);
  });

  test("preserves bytes, progress and normal response completion", async () => {
    const chunks: Buffer[] = [];
    const progress: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("first"));
        controller.enqueue(Buffer.from("second"));
        controller.close();
      },
    });
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setTimeout(callback, 2);
      },
    });
    await pipeWebStreamToNodeResponse({
      stream,
      res: destination as unknown as ServerResponse,
      onChunk: (chunk) => {
        progress.push(Buffer.from(chunk).toString());
      },
    });
    expect(Buffer.concat(chunks).toString()).toBe("firstsecond");
    expect(progress.join("")).toBe("firstsecond");
    expect(destination.writableFinished).toBe(true);
  });

  test("progress callback errors cancel upstream and reject the transfer", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("first"));
      },
      cancel() {
        canceled = true;
      },
    });
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const pending = pipeWebStreamToNodeResponse({
      stream,
      res: destination as unknown as ServerResponse,
      onChunk() {
        throw new Error("progress failed");
      },
    });
    expect(await outcome(pending)).toBe("failed");
    expect(canceled).toBe(true);
    expect(destination.destroyed).toBe(true);
  });

  test("an upstream error destroys the response instead of reporting graceful completion", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(Buffer.from("partial"));
      },
    });
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const pending = pipeWebStreamToNodeResponse({
      stream,
      res: destination as unknown as ServerResponse,
    });
    await Bun.sleep(10);
    controller!.error(new Error("upstream reset"));
    expect(await outcome(pending)).toBe("failed");
    expect(destination.destroyed).toBe(true);
    expect(destination.writableFinished).toBe(false);
  });
});
