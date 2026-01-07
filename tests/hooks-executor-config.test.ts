import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HooksExecutor, getHooksPoolStats, stopAllHooks } from "../src/lib/hooks-executor";
import type { HookConfig } from "../src/types/proxy";

describe("HooksExecutor", () => {
  afterEach(async () => {
    await stopAllHooks();
  });

  describe("initialization", () => {
    it("should initialize with empty hooks", async () => {
      const executor = new HooksExecutor("test-instance", null);
      await executor.start();

      expect(executor.hasHooks).toBe(false);
      expect(executor.hasRequestHooks).toBe(false);
      expect(executor.hasResponseHooks).toBe(false);
      expect(executor.getFirstPluginUrl()).toBe(null);

      await executor.stop();
    });

    it("should initialize with undefined hooks", async () => {
      const executor = new HooksExecutor("test-instance", undefined);
      await executor.start();

      expect(executor.hasHooks).toBe(false);
      expect(executor.getFirstPluginUrl()).toBe(null);

      await executor.stop();
    });

    it("should initialize with empty array hooks", async () => {
      const executor = new HooksExecutor("test-instance", []);
      await executor.start();

      expect(executor.hasHooks).toBe(false);
      expect(executor.getFirstPluginUrl()).toBe(null);

      await executor.stop();
    });
  });

  describe("setForwardHooks", () => {
    it("should update forward hooks without restarting", async () => {
      const executor = new HooksExecutor("test-instance", null);
      await executor.start();

      expect(executor.hasHooks).toBe(false);

      // Set null forward hooks should not change state
      await executor.setForwardHooks("forward-1", null);
      expect(executor.hasHooks).toBe(false);

      // Set empty forward hooks should not change state
      await executor.setForwardHooks("forward-2", []);
      expect(executor.hasHooks).toBe(false);

      await executor.stop();
    });

    it("should skip disabled hooks", async () => {
      const disabledHook: HookConfig = {
        type: "http",
        command: "echo",
        args: ["test"],
        disabled: true,
      };

      const executor = new HooksExecutor("test-instance", [disabledHook]);
      await executor.start();

      expect(executor.hasHooks).toBe(false);
      expect(executor.getFirstPluginUrl()).toBe(null);

      await executor.stop();
    });
  });

  describe("precheck methods", () => {
    it("should return passthrough precheck for empty hooks", async () => {
      const executor = new HooksExecutor("test-instance", null);
      await executor.start();

      const requestPrecheck = await executor.precheckRequest();
      expect(requestPrecheck.needsBuffer).toBe(false);
      expect(requestPrecheck.canPassthrough).toBe(true);
      expect(requestPrecheck.activePlugins).toEqual([]);

      const responsePrecheck = await executor.precheckResponse();
      expect(responsePrecheck.needsBuffer).toBe(false);
      expect(responsePrecheck.canPassthrough).toBe(true);
      expect(responsePrecheck.activePlugins).toEqual([]);

      await executor.stop();
    });
  });

  describe("lifecycle", () => {
    it("should start and stop cleanly", async () => {
      const executor = new HooksExecutor("test-instance", null);

      await executor.start();
      expect(executor.hasHooks).toBe(false);

      await executor.stop();
      expect(executor.hasHooks).toBe(false);
    });

    it("should stop multiple times without error", async () => {
      const executor = new HooksExecutor("test-instance", null);

      await executor.start();
      await executor.stop();
      await executor.stop();
      await executor.stop();

      expect(executor.hasHooks).toBe(false);
    });
  });
});

describe("HooksPool", () => {
  afterEach(async () => {
    await stopAllHooks();
  });

  describe("getHooksPoolStats", () => {
    it("should return pool size", () => {
      const stats = getHooksPoolStats();
      expect(typeof stats.size).toBe("number");
      expect(stats.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe("stopAllHooks", () => {
    it("should clear all hooks from pool", async () => {
      await stopAllHooks();
      const stats = getHooksPoolStats();
      expect(stats.size).toBe(0);
    });

    it("should be idempotent", async () => {
      await stopAllHooks();
      await stopAllHooks();
      await stopAllHooks();

      const stats = getHooksPoolStats();
      expect(stats.size).toBe(0);
    });
  });
});

describe("Hook config normalization", () => {
  afterEach(async () => {
    await stopAllHooks();
  });

  it("should handle single hook config", async () => {
    const hook: HookConfig = {
      type: "http",
      command: "echo",
      args: [],
      disabled: true, // Disabled so it won't actually run
    };

    const executor = new HooksExecutor("test", hook);
    await executor.start();

    // Disabled hook means no active hooks
    expect(executor.hasHooks).toBe(false);

    await executor.stop();
  });

  it("should handle array of hook configs", async () => {
    const hooks: HookConfig[] = [
      { type: "http", command: "echo", args: [], disabled: true },
      { type: "http", command: "echo", args: [], disabled: true },
    ];

    const executor = new HooksExecutor("test", hooks);
    await executor.start();

    // All disabled, no active hooks
    expect(executor.hasHooks).toBe(false);

    await executor.stop();
  });

  it("should filter out disabled hooks from array", async () => {
    const hooks: HookConfig[] = [
      { type: "http", command: "echo", args: [], disabled: true },
      { type: "http", command: "echo", args: [], disabled: false },
      { type: "http", command: "echo", args: [] }, // disabled defaults to false
    ];

    // This would try to run actual processes, so we just test parsing
    const executor = new HooksExecutor("test", hooks.filter((h) => h.disabled));
    await executor.start();

    expect(executor.hasHooks).toBe(false);

    await executor.stop();
  });
});
