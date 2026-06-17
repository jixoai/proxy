/**
 * 测试 model-rewrite 插件的并发隔离
 *
 * 问题场景：
 * - 请求A使用 model-rewrite 将模型改为 glm-5.1
 * - 请求B不使用 model-rewrite
 * - 由于共享状态，请求B可能会意外使用请求A的插件配置
 *
 * 修复方案：
 * - 将 forwardHooksLoaded 从实例级别改为请求级别
 * - 每个请求独立加载自己的 forward hooks
 */

import { describe, test, expect } from "bun:test";
import { HooksExecutor } from "../src/lib/hooks-executor";

describe("Model Rewrite Plugin Concurrency", () => {
  test("每个请求应独立加载 forward hooks，避免并发竞态", async () => {
    const executor = new HooksExecutor("test-instance", null);
    await executor.start();

    // 模拟两个并发请求加载不同的 hooks
    const hooks1 = {
      type: "http" as const,
      command: "plugin",
      args: ["@jixo/proxy-plugin-model-rewrite"],
      config: { model: "glm-5.1" },
    };

    const hooks2 = null; // 不使用任何插件

    // 并发加载
    const [loaded1, loaded2] = await Promise.all([
      executor.loadForwardHooks(hooks1),
      executor.loadForwardHooks(hooks2),
    ]);

    // 验证结果独立
    expect(loaded1.length).toBe(1);
    expect(loaded1[0]?.pluginName).toBe("proxy-plugin-model-rewrite");

    expect(loaded2.length).toBe(0);

    await executor.stop();
  });

  test("setForwardHooks 应该被废弃并且不影响状态", async () => {
    const executor = new HooksExecutor("test-instance", null);
    await executor.start();

    // 调用废弃的方法不应抛出错误
    await expect(executor.setForwardHooks("test", {
      type: "http" as const,
      command: "plugin",
      args: ["@jixo/proxy-plugin-model-rewrite"],
      config: { model: "glm-5.1" },
    })).resolves.toBeUndefined();

    await executor.stop();
  });

  test("hasRequestHooks 应该只检查 instance hooks", async () => {
    const executor1 = new HooksExecutor("test-instance-1", {
      type: "http" as const,
      command: "plugin",
      args: ["@jixo/proxy-plugin-model-rewrite"],
      config: { model: "glm-5.1" },
    });

    await executor1.start();
    expect(executor1.hasRequestHooks).toBe(true);
    await executor1.stop();

    const executor2 = new HooksExecutor("test-instance-2", null);
    await executor2.start();
    expect(executor2.hasRequestHooks).toBe(false);
    await executor2.stop();
  });
});
