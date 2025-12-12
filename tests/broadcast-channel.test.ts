import { describe, expect, it } from "bun:test";
// import { Worker, BroadcastChannel } from "node:worker_threads";

const waitForMessage = <T = unknown>(channel: BroadcastChannel, label: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener("message", onMessage as EventListener);
      reject(new Error(`${label} timed out`));
    }, 2_000);

    const onMessage = (event: MessageEvent<T>) => {
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage as EventListener);
      resolve(event.data);
    };

    channel.addEventListener("message", onMessage as EventListener);
  });

describe("BroadcastChannel in Bun Worker", () => {
  it("supports bidirectional messaging between main thread and worker", async () => {
    const mainChannel = new BroadcastChannel("test-channel");

    const workerScript = `
      const channel = new BroadcastChannel('test-channel');
      channel.addEventListener('message', (event) => {
        if (event.data === 'pong-from-main') {
          channel.postMessage('ack-from-worker');
        }
      });
      channel.postMessage('ping-from-worker');
    `;

    const workerUrl = URL.createObjectURL(
      new Blob([workerScript], { type: "application/javascript" }),
    );

    const worker = new Worker(workerUrl, { type: "module" });

    try {
      const firstMessage = await waitForMessage<string>(
        mainChannel,
        "main waiting for worker ping",
      );
      expect(firstMessage).toBe("ping-from-worker");

      mainChannel.postMessage("pong-from-main");

      const secondMessage = await waitForMessage<string>(
        mainChannel,
        "main waiting for worker ack",
      );
      expect(secondMessage).toBe("ack-from-worker");
    } finally {
      mainChannel.close();
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  });
});
