import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startViewerServer } from "../../src/viewer-server";
import { ProxyInstancesManager } from "../../src/proxy-instances-manager";
import { overrideConfigFilePathForTests, loadConfig } from "../../src/lib/config-store";
import { initDatabase } from "../../src/lib/db";
import { setDataDir } from "../../src/lib/runtime-paths";
import type { ProxyConfigFile, ProxyInstanceConfig } from "../../src/types/proxy";

const TEST_DIR = path.join(__dirname, "../../.tmp/api-tests");
const TEST_CONFIG_PATH = path.join(TEST_DIR, "proxy-config.json");
const TEST_DATA_DIR = path.join(TEST_DIR, "data");
const TEST_PORT = 19999;

function cleanupTestDir() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function createTestConfig(): ProxyConfigFile {
  return {
    instances: [
      {
        name: "test-instance",
        port: 29999,
        enabled: false,
        description: "Test instance for API tests",
        headers: null,
        forwards: [
          {
            name: "test-forward",
            enabled: true,
            target: "https://httpbin.org",
            description: "Test forward rule",
            path: null,
            methods: ["*"],
            headers: null,
          },
        ],
      },
    ],
  };
}

async function fetchAPI(endpoint: string, options?: RequestInit) {
  const response = await fetch(`http://localhost:${TEST_PORT}${endpoint}`, options);
  return response;
}

describe("Viewer API", () => {
  let server: ReturnType<typeof startViewerServer>;
  let manager: ProxyInstancesManager;

  beforeAll(async () => {
    cleanupTestDir();
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(createTestConfig()));

    // Initialize config and database
    overrideConfigFilePathForTests(TEST_CONFIG_PATH);
    setDataDir(TEST_DATA_DIR);
    initDatabase();

    manager = new ProxyInstancesManager();
    server = startViewerServer(manager, TEST_PORT);

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    await manager.stopAll();
    server.stop();
    cleanupTestDir();
  });

  describe("GET /api/config", () => {
    test("should return current config", async () => {
      const response = await fetchAPI("/api/config");
      expect(response.ok).toBe(true);

      const config = await response.json();
      expect(config.instances).toBeDefined();
      expect(config.instances.length).toBeGreaterThan(0);
      expect(config.instances[0].name).toBe("test-instance");
    });
  });

  describe("PUT /api/config", () => {
    test("should update config", async () => {
      const newConfig = createTestConfig();
      newConfig.instances[0]!.description = "Updated description";

      const response = await fetchAPI("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.success).toBe(true);

      // Verify change persisted
      const getResponse = await fetchAPI("/api/config");
      const config = await getResponse.json();
      expect(config.instances[0].description).toBe("Updated description");
    });

    test("should handle invalid config", async () => {
      const response = await fetchAPI("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: "config" }),
      });

      expect(response.ok).toBe(false);
    });
  });

  describe("GET /api/runtime/statuses", () => {
    test("should return all instance statuses", async () => {
      const response = await fetchAPI("/api/runtime/statuses");
      expect(response.ok).toBe(true);

      const statuses = await response.json();
      expect(statuses["test-instance"]).toBeDefined();
      expect(statuses["test-instance"].running).toBe(false);
    });
  });

  describe("GET /api/runtime/instances/:name/status", () => {
    test("should return specific instance status", async () => {
      const response = await fetchAPI("/api/runtime/instances/test-instance/status");
      expect(response.ok).toBe(true);

      const status = await response.json();
      expect(status.running).toBe(false);
      expect(status.port).toBe(29999);
    });

    test("should handle encoded instance names", async () => {
      // First add an instance with special characters
      const config = loadConfig();
      config.instances.push({
        name: "test/special:instance",
        port: 29998,
        enabled: false,
        description: null,
        headers: null,
        forwards: [],
      });
      await fetchAPI("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      const response = await fetchAPI(
        `/api/runtime/instances/${encodeURIComponent("test/special:instance")}/status`,
      );
      expect(response.ok).toBe(true);
    });
  });

  describe("GET /api/requests", () => {
    test("should return empty array when no requests", async () => {
      const response = await fetchAPI("/api/requests");
      expect(response.ok).toBe(true);

      const requests = await response.json();
      expect(Array.isArray(requests)).toBe(true);
    });
  });

  describe("GET /api/stats", () => {
    test("should return stats object", async () => {
      const response = await fetchAPI("/api/stats");
      expect(response.ok).toBe(true);

      const stats = await response.json();
      expect(typeof stats).toBe("object");
    });
  });

  describe("GET /api/settings/db-path", () => {
    test("should return db path settings", async () => {
      const response = await fetchAPI("/api/settings/db-path");
      expect(response.ok).toBe(true);

      const settings = await response.json();
      expect(settings).toHaveProperty("dbPath");
      expect(settings).toHaveProperty("currentDataDir");
    });
  });

  describe("POST /api/reload", () => {
    test("should reload config for running instances", async () => {
      const response = await fetchAPI("/api/reload", { method: "POST" });
      expect(response.ok).toBe(true);

      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.reloaded).toBeDefined();
      expect(result.failed).toBeDefined();
    });
  });

  describe("Instance Operations", () => {
    beforeAll(async () => {
      // Add a startable instance to the config
      const config = loadConfig();
      config.instances.push({
        name: "startable-instance",
        port: 29997,
        enabled: true,
        description: "Instance for start/stop tests",
        headers: null,
        forwards: [
          {
            name: "forward",
            enabled: true,
            target: "https://httpbin.org",
            description: null,
            path: null,
            methods: ["*"],
            headers: null,
          },
        ],
      });
      await fetchAPI("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
    });

    test("should start an instance", async () => {
      const response = await fetchAPI("/api/runtime/instances/startable-instance/start", {
        method: "POST",
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.status.running).toBe(true);
    });

    test("should get instance status after start", async () => {
      const response = await fetchAPI("/api/runtime/instances/startable-instance/status");

      expect(response.ok).toBe(true);
      const status = await response.json();
      expect(status.running).toBe(true);
      expect(status.port).toBe(29997);
    });

    test("should push config to running instance", async () => {
      const response = await fetchAPI("/api/runtime/instances/startable-instance/push-config", {
        method: "POST",
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.success).toBe(true);
    });

    test("should check config sync status", async () => {
      const response = await fetchAPI("/api/runtime/instances/startable-instance/config-sync");

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result).toHaveProperty("synced");
      expect(result).toHaveProperty("workerConfig");
      expect(result).toHaveProperty("fileConfig");
    });

    test("should stop an instance", async () => {
      const response = await fetchAPI("/api/runtime/instances/startable-instance/stop", {
        method: "POST",
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.status.running).toBe(false);
    });

    test("should fail to push config to stopped instance", async () => {
      const response = await fetchAPI("/api/runtime/instances/startable-instance/push-config", {
        method: "POST",
      });

      expect(response.ok).toBe(false);
      const result = await response.json();
      expect(result.success).toBe(false);
    });
  });
});
