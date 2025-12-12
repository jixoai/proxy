// 测试 node:worker_threads 的 BroadcastChannel 是否支持跨 Worker 通信
import { Worker, BroadcastChannel, isMainThread, parentPort } from "node:worker_threads";

const CHANNEL_NAME = "test-worker-threads-channel";

if (isMainThread) {
  // 主线程
  console.log("[Main] Starting test...");

  // 创建 BroadcastChannel
  const channel = new BroadcastChannel(CHANNEL_NAME);
  console.log("[Main] BroadcastChannel created:", CHANNEL_NAME);

  let receivedFromWorker = false;

  channel.onmessage = (event) => {
    console.log("[Main] Received from BroadcastChannel:", event.data);
    receivedFromWorker = true;
  };

  // 创建 Worker（运行自己）
  const worker = new Worker(new URL(import.meta.url));

  worker.on("message", (msg) => {
    console.log("[Main] Received from Worker via postMessage:", msg);
  });

  // 等待 Worker 准备好
  worker.on("online", () => {
    console.log("[Main] Worker is online");
  });

  // 等待几秒后检查结果
  setTimeout(() => {
    console.log("\n=== Test Result ===");
    console.log("Received via BroadcastChannel:", receivedFromWorker);

    if (!receivedFromWorker) {
      console.log("\n❌ FAILED: node:worker_threads BroadcastChannel does NOT support cross-thread communication!");
      console.log("This explains why DbNotifier messages are not received by DbListener.");
    } else {
      console.log("\n✅ PASSED: BroadcastChannel works across threads");
    }

    channel.close();
    worker.terminate();
  }, 3000);

} else {
  // Worker 线程
  console.log("[Worker] Starting...");

  // 创建 BroadcastChannel
  const channel = new BroadcastChannel(CHANNEL_NAME);
  console.log("[Worker] BroadcastChannel created:", CHANNEL_NAME);

  // 发送消息
  channel.postMessage({ type: "hello", from: "worker" });
  console.log("[Worker] Message sent via BroadcastChannel");

  // 同时用 parentPort 发送一条消息（验证 Worker 通信正常）
  parentPort?.postMessage({ type: "hello", via: "postMessage" });
  console.log("[Worker] Message sent via parentPort");
}
