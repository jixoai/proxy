import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ProxyConfigStore,
  type InstanceChangeEvent,
  type ForwardChangeEvent,
} from "../../src/lib/store/proxy-config-store";
import type { ProxyInstanceConfig, ProxyForwardConfig } from "../../src/types/proxy";

const TEST_DIR = path.join(__dirname, "../../.tmp/store-tests");
const TEST_CONFIG_PATH = path.join(TEST_DIR, "proxy-config.json");

function cleanupTestDir() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function createTestInstance(name: string, port: number): ProxyInstanceConfig {
  return {
    name,
    port,
    enabled: true,
    description: `Test instance ${name}`,
    headers: null,
    forwards: [],
  };
}

function createTestForward(name: string, target: string): ProxyForwardConfig {
  return {
    name,
    enabled: true,
    target,
    description: `Test forward ${name}`,
    path: null,
    methods: ["*"],
    headers: null,
  };
}

describe("ProxyConfigStore", () => {
  let store: ProxyConfigStore;

  beforeEach(() => {
    cleanupTestDir();
    ProxyConfigStore.resetInstance();
  });

  afterEach(() => {
    if (store && !store.isDestroyed()) {
      store.destroy();
    }
    ProxyConfigStore.resetInstance();
  });

  describe("initialization", () => {
    test("should create default config file if missing", () => {
      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });

      expect(fs.existsSync(TEST_CONFIG_PATH)).toBe(true);
      const instances = store.getAllInstances();
      expect(instances.length).toBeGreaterThan(0);
      expect(instances[0]!.name).toBe("AI");
    });

    test("should load existing config file", () => {
      const existingConfig = {
        instances: [createTestInstance("existing", 8000)],
      };
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(existingConfig));

      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });

      const instances = store.getAllInstances();
      expect(instances.length).toBe(1);
      expect(instances[0]!.name).toBe("existing");
      expect(instances[0]!.port).toBe(8000);
    });

    test("should persist generated forward ids on init", () => {
      const existingConfig = {
        instances: [
          {
            ...createTestInstance("existing", 8000),
            forwards: [createTestForward("f1", "https://example.com")],
          },
        ],
      };
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(existingConfig));

      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });

      const savedRaw = fs.readFileSync(TEST_CONFIG_PATH, "utf-8");
      const saved = JSON.parse(savedRaw) as {
        instances: Array<{ forwards: Array<{ id?: string }> }>;
      };
      const id = saved.instances[0]?.forwards[0]?.id;
      expect(typeof id).toBe("string");
      if (typeof id !== "string") throw new Error("id should be generated");
      expect(id.length).toBeGreaterThan(0);
    });

    test("should throw if file missing and createIfMissing is false", () => {
      expect(() => {
        new ProxyConfigStore({
          filePath: TEST_CONFIG_PATH,
          createIfMissing: false,
        });
      }).toThrow("Config file not found");
    });

    test("should return singleton instance", () => {
      const existingConfig = {
        instances: [createTestInstance("singleton", 9000)],
      };
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(existingConfig));

      store = ProxyConfigStore.getInstance({ filePath: TEST_CONFIG_PATH });
      const store2 = ProxyConfigStore.getInstance();

      expect(store).toBe(store2);
    });
  });

  describe("instance operations", () => {
    beforeEach(() => {
      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });
    });

    test("should get instance by name", () => {
      const instance = store.getInstanceByName("AI");
      expect(instance).not.toBeNull();
      expect(instance!.name).toBe("AI");
    });

    test("should return null for non-existent instance", () => {
      const instance = store.getInstanceByName("non-existent");
      expect(instance).toBeNull();
    });

    test("should create new instance", () => {
      const newInstance = createTestInstance("new-instance", 9001);
      store.upsertInstance(newInstance);

      const saved = store.getInstanceByName("new-instance");
      expect(saved).not.toBeNull();
      expect(saved!.port).toBe(9001);

      // Verify persisted to file
      const fileContent = fs.readFileSync(TEST_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(fileContent);
      expect(parsed.instances.some((i: any) => i.name === "new-instance")).toBe(true);
    });

    test("should update existing instance", () => {
      const instance = store.getInstanceByName("AI")!;
      const updated = { ...instance, port: 28000, description: "Updated" };
      store.upsertInstance(updated);

      const saved = store.getInstanceByName("AI");
      expect(saved!.port).toBe(28000);
      expect(saved!.description).toBe("Updated");
    });

    test("should delete instance", () => {
      const newInstance = createTestInstance("to-delete", 9002);
      store.upsertInstance(newInstance);
      expect(store.getInstanceByName("to-delete")).not.toBeNull();

      const result = store.deleteInstance("to-delete");
      expect(result).toBe(true);
      expect(store.getInstanceByName("to-delete")).toBeNull();
    });

    test("should return false when deleting non-existent instance", () => {
      const result = store.deleteInstance("non-existent");
      expect(result).toBe(false);
    });

    test("should emit instance-change event on create", async () => {
      const events: InstanceChangeEvent[] = [];
      store.on("instance-change", (event) => events.push(event));

      const newInstance = createTestInstance("event-test", 9003);
      store.upsertInstance(newInstance);

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("create");
      expect(events[0]!.instanceName).toBe("event-test");
      expect(events[0]!.instance).toBeDefined();
      expect(events[0]!.previousInstance).toBeUndefined();
    });

    test("should emit instance-change event on update", async () => {
      const events: InstanceChangeEvent[] = [];
      store.on("instance-change", (event) => events.push(event));

      const instance = store.getInstanceByName("AI")!;
      const updated = { ...instance, port: 28001 };
      store.upsertInstance(updated);

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("update");
      expect(events[0]!.instanceName).toBe("AI");
      expect(events[0]!.previousInstance).toBeDefined();
      expect(events[0]!.previousInstance!.port).not.toBe(28001);
    });

    test("should emit instance-change event on delete", async () => {
      const events: InstanceChangeEvent[] = [];
      store.on("instance-change", (event) => events.push(event));

      store.deleteInstance("AI");

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("delete");
      expect(events[0]!.instanceName).toBe("AI");
      expect(events[0]!.previousInstance).toBeDefined();
    });
  });

  describe("forward operations", () => {
    beforeEach(() => {
      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });
    });

    test("should get forwards by instance name", () => {
      const forwards = store.getForwardsByInstanceName("AI");
      expect(forwards.length).toBeGreaterThan(0);
    });

    test("should return empty array for non-existent instance", () => {
      const forwards = store.getForwardsByInstanceName("non-existent");
      expect(forwards).toEqual([]);
    });

    test("should add forward to instance", () => {
      const forward = createTestForward("new-forward", "https://api.example.com");
      store.addForward("AI", forward);

      const forwards = store.getForwardsByInstanceName("AI");
      const added = forwards.find((f) => f.name === "new-forward");
      expect(added).toBeDefined();
      expect(added!.target).toBe("https://api.example.com");
    });

    test("should throw when adding forward to non-existent instance", () => {
      const forward = createTestForward("fail", "https://fail.com");
      expect(() => store.addForward("non-existent", forward)).toThrow("Instance not found");
    });

    test("should update forward by index", () => {
      const forwards = store.getForwardsByInstanceName("AI");
      const updated = { ...forwards[0]!, target: "https://updated.example.com" };
      store.updateForwardByIndex("AI", 0, updated);

      const newForwards = store.getForwardsByInstanceName("AI");
      expect(newForwards[0]!.target).toBe("https://updated.example.com");
    });

    test("should throw when updating forward with invalid index", () => {
      const forward = createTestForward("test", "https://test.com");
      expect(() => store.updateForwardByIndex("AI", 999, forward)).toThrow("out of range");
    });

    test("should delete forward by index", () => {
      const forward = createTestForward("to-delete", "https://delete.com");
      store.addForward("AI", forward);

      const beforeCount = store.getForwardsByInstanceName("AI").length;
      const result = store.deleteForwardByIndex("AI", beforeCount - 1);

      expect(result).toBe(true);
      expect(store.getForwardsByInstanceName("AI").length).toBe(beforeCount - 1);
    });

    test("should return false when deleting forward with invalid index", () => {
      const result = store.deleteForwardByIndex("AI", 999);
      expect(result).toBe(false);
    });

    test("should reorder forwards by indexes", () => {
      // Add some forwards first
      store.addForward("AI", createTestForward("A", "https://a.com"));
      store.addForward("AI", createTestForward("B", "https://b.com"));

      const forwards = store.getForwardsByInstanceName("AI");
      const originalOrder = forwards.map((f) => f.name);

      // Reverse the order
      const reversedIndexes = forwards.map((_, i) => forwards.length - 1 - i);
      store.reorderForwardsByIndexes("AI", reversedIndexes);

      const newForwards = store.getForwardsByInstanceName("AI");
      const newOrder = newForwards.map((f) => f.name);

      expect(newOrder).toEqual(originalOrder.reverse());
    });

    test("should emit forward-change event on add", () => {
      const events: ForwardChangeEvent[] = [];
      store.on("forward-change", (event) => events.push(event));

      store.addForward("AI", createTestForward("event-forward", "https://event.com"));

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("create");
      expect(events[0]!.instanceName).toBe("AI");
      expect(events[0]!.forward).toBeDefined();
    });

    test("should emit forward-change event on update", () => {
      const events: ForwardChangeEvent[] = [];
      store.on("forward-change", (event) => events.push(event));

      const forwards = store.getForwardsByInstanceName("AI");
      const updated = { ...forwards[0]!, enabled: false };
      store.updateForwardByIndex("AI", 0, updated);

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("update");
      expect(events[0]!.previousForward).toBeDefined();
    });

    test("should emit forward-change event on delete", () => {
      const events: ForwardChangeEvent[] = [];
      store.on("forward-change", (event) => events.push(event));

      store.deleteForwardByIndex("AI", 0);

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("delete");
    });

    test("should emit forward-change event on reorder", () => {
      store.addForward("AI", createTestForward("R1", "https://r1.com"));

      const events: ForwardChangeEvent[] = [];
      store.on("forward-change", (event) => events.push(event));

      const forwards = store.getForwardsByInstanceName("AI");
      store.reorderForwardsByIndexes(
        "AI",
        forwards.map((_, i) => forwards.length - 1 - i),
      );

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("reorder");
    });
  });

  describe("version tracking", () => {
    beforeEach(() => {
      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });
    });

    test("should increment version on changes", () => {
      const initialVersion = store.getVersion();

      store.upsertInstance(createTestInstance("v1", 9010));
      expect(store.getVersion()).toBe(initialVersion + 1);

      store.upsertInstance(createTestInstance("v2", 9011));
      expect(store.getVersion()).toBe(initialVersion + 2);
    });

    test("should emit change event with version info", () => {
      const changes: any[] = [];
      store.on("change", (event) => changes.push(event));

      store.upsertInstance(createTestInstance("change-test", 9012));

      expect(changes.length).toBe(1);
      expect(changes[0].timestamp).toBeGreaterThan(0);
      expect(changes[0].data).toBeDefined();
      expect(changes[0].previousData).toBeDefined();
    });
  });

  describe("data isolation", () => {
    beforeEach(() => {
      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });
    });

    test("should return cloned data to prevent mutation", () => {
      const instances1 = store.getAllInstances();
      const instances2 = store.getAllInstances();

      expect(instances1).not.toBe(instances2);
      expect(instances1[0]).not.toBe(instances2[0]);

      // Mutating returned data should not affect store
      instances1[0]!.port = 99999;
      const instances3 = store.getAllInstances();
      expect(instances3[0]!.port).not.toBe(99999);
    });

    test("should return cloned instance", () => {
      const instance1 = store.getInstanceByName("AI");
      const instance2 = store.getInstanceByName("AI");

      expect(instance1).not.toBe(instance2);
      expect(instance1!.forwards).not.toBe(instance2!.forwards);
    });
  });

  describe("file persistence", () => {
    test("should persist changes to file immediately", () => {
      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });

      store.upsertInstance(createTestInstance("persist-test", 9020));

      // Read directly from file
      const fileContent = fs.readFileSync(TEST_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(fileContent);

      expect(parsed.instances.some((i: any) => i.name === "persist-test")).toBe(true);
    });

    test("should handle concurrent modifications", () => {
      store = new ProxyConfigStore({ filePath: TEST_CONFIG_PATH });

      // Rapid concurrent modifications
      for (let i = 0; i < 10; i++) {
        store.upsertInstance(createTestInstance(`concurrent-${i}`, 9030 + i));
      }

      const instances = store.getAllInstances();
      for (let i = 0; i < 10; i++) {
        expect(instances.some((inst) => inst.name === `concurrent-${i}`)).toBe(true);
      }
    });
  });
});
