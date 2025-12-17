import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startViewerServer } from "../../src/viewer-server";
import { ProxyInstancesManager } from "../../src/proxy-instances-manager";
import { overrideConfigFilePathForTests } from "../../src/lib/config-store";
import { initDatabase } from "../../src/lib/db";
import { setDataDir } from "../../src/lib/runtime-paths";
import type { ProxyConfigFile } from "../../src/types/proxy";

const TEST_DIR = path.join(__dirname, "../../.tmp/ws-tests");
const TEST_CONFIG_PATH = path.join(TEST_DIR, "proxy-config.json");
const TEST_DATA_DIR = path.join(TEST_DIR, "data");
const TEST_PORT = 19998;

function cleanupTestDir() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function createTestConfig(): ProxyConfigFile {
  return {
    instances: [
      {
        name: "ws-test-instance",
        port: 29996,
        enabled: false,
        description: "Instance for WebSocket tests",
        headers: null,
        forwards: [
          {
            name: "test-forward",
            enabled: true,
            target: "https://httpbin.org",
            description: null,
            path: null,
            methods: ["*"],
            headers: null,
          },
        ],
      },
    ],
  };
}

function connectWebSocket(
  port: number,
  endpoint: string,
): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://localhost:${port}${endpoint}`);

    ws.onopen = () => {
      resolve({ ws, messages });
    };

    ws.onmessage = (event) => {
      try {
        messages.push(JSON.parse(event.data));
      } catch {
        messages.push(event.data);
      }
    };

    ws.onerror = (error) => {
      reject(error);
    };

    setTimeout(() => {
      reject(new Error("WebSocket connection timeout"));
    }, 5000);
  });
}

function waitForMessage(
  messages: any[],
  predicate: (msg: any) => boolean,
  timeoutMs: number = 3000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const startLength = messages.length;

    const checkExisting = () => {
      for (let i = startLength - 1; i >= 0; i--) {
        if (predicate(messages[i])) {
          return messages[i];
        }
      }
      return null;
    };

    const existing = checkExisting();
    if (existing) {
      resolve(existing);
      return;
    }

    const interval = setInterval(() => {
      for (let i = messages.length - 1; i >= startLength; i--) {
        if (predicate(messages[i])) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve(messages[i]);
          return;
        }
      }
    }, 50);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timeout waiting for message. Received: ${JSON.stringify(messages)}`));
    }, timeoutMs);
  });
}

describe("Viewer WebSocket", () => {
  let server: ReturnType<typeof startViewerServer>;
  let manager: ProxyInstancesManager;

  beforeAll(async () => {
    cleanupTestDir();
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(createTestConfig()));

    overrideConfigFilePathForTests(TEST_CONFIG_PATH);
    setDataDir(TEST_DATA_DIR);
    initDatabase();

    manager = new ProxyInstancesManager();
    server = startViewerServer(manager, TEST_PORT);

    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    await manager.stopAll();
    server.stop();
    cleanupTestDir();
  });

  describe("/ws endpoint", () => {
    test("should connect successfully", async () => {
      const { ws } = await connectWebSocket(TEST_PORT, "/ws");
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    test("should receive initial instance states on connect", async () => {
      const { ws, messages } = await connectWebSocket(TEST_PORT, "/ws");

      // Wait for initial states message
      const statusMessage = await waitForMessage(
        messages,
        (msg) => msg.type === "all-instance-states",
      );

      expect(statusMessage.type).toBe("all-instance-states");
      expect(statusMessage.statuses).toBeDefined();
      expect(statusMessage.statuses["ws-test-instance"]).toBeDefined();

      ws.close();
    });

    test("should receive instance-state-changed on instance start", async () => {
      const { ws, messages } = await connectWebSocket(TEST_PORT, "/ws");

      // Wait for initial message
      await waitForMessage(messages, (msg) => msg.type === "all-instance-states");

      // Start instance via API
      await fetch(`http://localhost:${TEST_PORT}/api/runtime/instances/ws-test-instance/start`, {
        method: "POST",
      });

      // Wait for status change message
      const changeMessage = await waitForMessage(
        messages,
        (msg) =>
          msg.type === "instance-state-changed" && msg.instanceName === "ws-test-instance",
      );

      expect(changeMessage.type).toBe("instance-state-changed");
      expect(changeMessage.instanceName).toBe("ws-test-instance");
      expect(changeMessage.status.running).toBe(true);

      // Stop instance
      await fetch(`http://localhost:${TEST_PORT}/api/runtime/instances/ws-test-instance/stop`, {
        method: "POST",
      });

      ws.close();
    });

    test("should receive instance-state-changed on instance stop", async () => {
      // First start the instance
      await fetch(`http://localhost:${TEST_PORT}/api/runtime/instances/ws-test-instance/start`, {
        method: "POST",
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      const { ws, messages } = await connectWebSocket(TEST_PORT, "/ws");

      // Wait for initial message
      await waitForMessage(messages, (msg) => msg.type === "all-instance-states");

      // Stop instance via API
      await fetch(`http://localhost:${TEST_PORT}/api/runtime/instances/ws-test-instance/stop`, {
        method: "POST",
      });

      // Wait for status change message
      const changeMessage = await waitForMessage(
        messages,
        (msg) =>
          msg.type === "instance-state-changed" &&
          msg.instanceName === "ws-test-instance" &&
          msg.status.running === false,
      );

      expect(changeMessage.type).toBe("instance-state-changed");
      expect(changeMessage.status.running).toBe(false);

      ws.close();
    });

    test("should receive config-changed message on config update", async () => {
      const { ws, messages } = await connectWebSocket(TEST_PORT, "/ws");

      // Wait for initial message
      await waitForMessage(messages, (msg) => msg.type === "all-instance-states");

      // Update config via API
      const config = createTestConfig();
      config.instances[0]!.description = "Updated via WS test";

      await fetch(`http://localhost:${TEST_PORT}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      // Wait for config-changed message
      const configMessage = await waitForMessage(messages, (msg) => msg.type === "config-changed");

      expect(configMessage.type).toBe("config-changed");

      ws.close();
    });
  });

  // Note: /ws/logs and /ws/stats endpoints are not implemented in viewer-server
  // They could be added in the future if needed

  describe("multiple clients", () => {
    test("should broadcast to all connected clients", async () => {
      const client1 = await connectWebSocket(TEST_PORT, "/ws");
      const client2 = await connectWebSocket(TEST_PORT, "/ws");

      // Wait for initial messages
      await waitForMessage(client1.messages, (msg) => msg.type === "all-instance-states");
      await waitForMessage(client2.messages, (msg) => msg.type === "all-instance-states");

      // Start instance
      await fetch(`http://localhost:${TEST_PORT}/api/runtime/instances/ws-test-instance/start`, {
        method: "POST",
      });

      // Both clients should receive the update
      const change1 = await waitForMessage(
        client1.messages,
        (msg) =>
          msg.type === "instance-state-changed" && msg.instanceName === "ws-test-instance",
      );
      const change2 = await waitForMessage(
        client2.messages,
        (msg) =>
          msg.type === "instance-state-changed" && msg.instanceName === "ws-test-instance",
      );

      expect(change1.status.running).toBe(true);
      expect(change2.status.running).toBe(true);

      // Cleanup
      await fetch(`http://localhost:${TEST_PORT}/api/runtime/instances/ws-test-instance/stop`, {
        method: "POST",
      });

      client1.ws.close();
      client2.ws.close();
    });
  });
});
