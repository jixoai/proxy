import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InstanceRuntimeStore,
  type RuntimeChangeEvent,
} from "../../src/lib/store/instance-runtime-store";
import type { InstanceRuntimeConfig } from "../../src/types/worker-messages";

function createTestConfig(name: string): InstanceRuntimeConfig {
  return {
    name,
    headers: { Authorization: "Bearer test-token" },
    hooks: null,
    forwards: [
      {
        id: "test-forward-id",
        name: "default",
        enabled: true,
        target: "https://api.example.com",
        description: "Test forward",
        path: "/api",
        methods: ["GET", "POST"],
        headers: null,
      },
    ],
  };
}

describe("InstanceRuntimeStore", () => {
  let store: InstanceRuntimeStore;

  beforeEach(() => {
    store = new InstanceRuntimeStore();
  });

  afterEach(() => {
    if (!store.isDestroyed()) {
      store.destroy();
    }
  });

  describe("initialization", () => {
    test("should start uninitialized", () => {
      expect(store.isInitialized()).toBe(false);
      expect(store.getConfig()).toBeNull();
      expect(store.getVersion()).toBe(0);
    });

    test("should initialize with config", () => {
      const config = createTestConfig("test-instance");
      store.init(config);

      expect(store.isInitialized()).toBe(true);
      expect(store.getConfig()).not.toBeNull();
      expect(store.getConfig()!.name).toBe("test-instance");
      expect(store.getVersion()).toBe(1);
    });

    test("should emit init event", () => {
      const events: RuntimeChangeEvent[] = [];
      store.on("init", (event) => events.push(event));
      store.on("change", (event) => events.push(event));

      const config = createTestConfig("event-test");
      store.init(config);

      expect(events.length).toBe(2);
      expect(events.some((e) => e.type === "init")).toBe(true);
      expect(events[0]!.config.name).toBe("event-test");
    });
  });

  describe("reload", () => {
    test("should update config on reload", () => {
      const config1 = createTestConfig("instance-1");
      store.init(config1);

      const config2 = createTestConfig("instance-2");
      config2.headers = { "X-Custom": "value" };
      store.reload(config2);

      expect(store.getConfig()!.name).toBe("instance-2");
      expect(store.getConfig()!.headers).toEqual({ "X-Custom": "value" });
      expect(store.getVersion()).toBe(2);
    });

    test("should emit reload event with previous config", () => {
      const config1 = createTestConfig("reload-test-1");
      store.init(config1);

      const events: RuntimeChangeEvent[] = [];
      store.on("reload", (event) => events.push(event));

      const config2 = createTestConfig("reload-test-2");
      store.reload(config2);

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("reload");
      expect(events[0]!.previousConfig).toBeDefined();
      expect(events[0]!.previousConfig!.name).toBe("reload-test-1");
      expect(events[0]!.config.name).toBe("reload-test-2");
    });
  });

  describe("getters", () => {
    beforeEach(() => {
      const config = createTestConfig("getter-test");
      config.headers = { Authorization: "Bearer token" };
      config.forwards = [
        {
          id: "enabled-forward-id",
          name: "enabled",
          enabled: true,
          target: "https://enabled.com",
          description: null,
          path: null,
          methods: ["*"],
          headers: null,
        },
        {
          id: "disabled-forward-id",
          name: "disabled",
          enabled: false,
          target: "https://disabled.com",
          description: null,
          path: null,
          methods: ["*"],
          headers: null,
        },
      ];
      store.init(config);
    });

    test("should get instance name", () => {
      expect(store.getInstanceName()).toBe("getter-test");
    });

    test("should get headers", () => {
      expect(store.getHeaders()).toEqual({ Authorization: "Bearer token" });
    });

    test("should get all forwards", () => {
      const forwards = store.getForwards();
      expect(forwards.length).toBe(2);
    });

    test("should get only enabled forwards", () => {
      const forwards = store.getEnabledForwards();
      expect(forwards.length).toBe(1);
      expect(forwards[0]!.name).toBe("enabled");
    });

    test("should return null for uninitialized store", () => {
      const newStore = new InstanceRuntimeStore();
      expect(newStore.getInstanceName()).toBeNull();
      expect(newStore.getHeaders()).toBeNull();
      expect(newStore.getForwards()).toEqual([]);
      newStore.destroy();
    });
  });

  describe("config comparison", () => {
    test("should detect equal configs", () => {
      const config = createTestConfig("compare-test");
      store.init(config);

      const sameConfig = createTestConfig("compare-test");
      expect(store.isConfigEqual(sameConfig)).toBe(true);
    });

    test("should detect different configs", () => {
      const config1 = createTestConfig("compare-1");
      store.init(config1);

      const config2 = createTestConfig("compare-2");
      expect(store.isConfigEqual(config2)).toBe(false);
    });

    test("should detect config changes in headers", () => {
      const config = createTestConfig("header-compare");
      store.init(config);

      const modified = createTestConfig("header-compare");
      modified.headers = { Different: "header" };
      expect(store.isConfigEqual(modified)).toBe(false);
    });

    test("should detect config changes in forwards", () => {
      const config = createTestConfig("forward-compare");
      store.init(config);

      const modified = createTestConfig("forward-compare");
      modified.forwards[0]!.target = "https://different.com";
      expect(store.isConfigEqual(modified)).toBe(false);
    });

    test("should return false when uninitialized", () => {
      const config = createTestConfig("uninit-compare");
      expect(store.isConfigEqual(config)).toBe(false);
    });
  });

  describe("data isolation", () => {
    test("should return cloned config", () => {
      const config = createTestConfig("isolation-test");
      store.init(config);

      const config1 = store.getConfig();
      const config2 = store.getConfig();

      expect(config1).not.toBe(config2);
      expect(config1!.forwards).not.toBe(config2!.forwards);
    });

    test("should not affect store when mutating returned config", () => {
      const config = createTestConfig("mutation-test");
      store.init(config);

      const retrieved = store.getConfig()!;
      retrieved.name = "mutated";
      retrieved.forwards[0]!.target = "https://mutated.com";

      const fresh = store.getConfig()!;
      expect(fresh.name).toBe("mutation-test");
      expect(fresh.forwards[0]!.target).toBe("https://api.example.com");
    });

    test("should not be affected by input mutation", () => {
      const config = createTestConfig("input-mutation");
      store.init(config);

      // Mutate original input
      config.name = "mutated-input";
      config.forwards[0]!.target = "https://mutated.com";

      const stored = store.getConfig()!;
      expect(stored.name).toBe("input-mutation");
    });
  });

  describe("version tracking", () => {
    test("should increment version on init", () => {
      expect(store.getVersion()).toBe(0);
      store.init(createTestConfig("v1"));
      expect(store.getVersion()).toBe(1);
    });

    test("should increment version on each reload", () => {
      store.init(createTestConfig("v1"));
      expect(store.getVersion()).toBe(1);

      store.reload(createTestConfig("v2"));
      expect(store.getVersion()).toBe(2);

      store.reload(createTestConfig("v3"));
      expect(store.getVersion()).toBe(3);
    });
  });

  describe("destroy", () => {
    test("should mark as destroyed", () => {
      store.init(createTestConfig("destroy-test"));
      expect(store.isDestroyed()).toBe(false);

      store.destroy();
      expect(store.isDestroyed()).toBe(true);
    });

    test("should clear config on destroy", () => {
      store.init(createTestConfig("clear-test"));
      store.destroy();

      expect(store.getConfig()).toBeNull();
    });

    test("should remove all listeners on destroy", () => {
      let called = false;
      store.on("change", () => {
        called = true;
      });

      store.destroy();
      store.init(createTestConfig("no-emit")); // This should not emit

      expect(called).toBe(false);
    });

    test("should ignore operations after destroy", () => {
      store.init(createTestConfig("pre-destroy"));
      store.destroy();

      store.init(createTestConfig("post-destroy"));
      expect(store.getConfig()).toBeNull(); // Should still be null
    });
  });

  describe("event handling", () => {
    test("should support multiple listeners", () => {
      const calls: string[] = [];
      store.on("change", () => calls.push("listener1"));
      store.on("change", () => calls.push("listener2"));

      store.init(createTestConfig("multi-listener"));

      expect(calls).toEqual(["listener1", "listener2"]);
    });

    test("should allow removing specific listener", () => {
      const calls: string[] = [];
      const listener = () => calls.push("removable");
      store.on("change", listener);
      store.on("change", () => calls.push("permanent"));

      store.off("change", listener);
      store.init(createTestConfig("remove-listener"));

      expect(calls).toEqual(["permanent"]);
    });

    test("should include timestamp in events", () => {
      const events: RuntimeChangeEvent[] = [];
      store.on("change", (event) => events.push(event));

      const before = Date.now();
      store.init(createTestConfig("timestamp-test"));
      const after = Date.now();

      expect(events[0]!.timestamp).toBeGreaterThanOrEqual(before);
      expect(events[0]!.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
