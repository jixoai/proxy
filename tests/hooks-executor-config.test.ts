import { describe, it, expect } from "bun:test";
import { HooksExecutor, getHooksPoolStats, stopAllHooks } from "../src/lib/hooks-executor";

describe("HooksExecutor", () => {
  it("should initialize with empty hooks", async () => {
    const executor = new HooksExecutor("test-instance", null);
    await executor.start();
    
    expect(executor.hasHooks).toBe(false);
    expect(executor.getFirstPluginUrl()).toBe(null);
    
    await executor.stop();
  });

  it("should track pool stats", () => {
    const stats = getHooksPoolStats();
    expect(typeof stats.size).toBe("number");
  });

  it("should stop all hooks", async () => {
    await stopAllHooks();
    const stats = getHooksPoolStats();
    expect(stats.size).toBe(0);
  });
});
