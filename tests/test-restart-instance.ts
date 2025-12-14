#!/usr/bin/env bun
/**
 * 测试实例重启逻辑
 * 验证：先启动 -> 停止 -> 再启动 不会发生端口冲突
 */

import { ProxyInstancesManager } from "../src/proxy-instances-manager";
import { loadConfig, saveConfig } from "../src/lib/config-store";

const TEST_PORT = 29999;
const TEST_INSTANCE_NAME = "test-restart";

// 全局超时
setTimeout(() => {
  console.error("\n[Test] ❌ Global timeout reached, exiting...");
  process.exit(1);
}, 30000);

async function setup() {
  // 确保测试实例存在于配置中
  const config = loadConfig();
  const existingIndex = config.instances.findIndex((i) => i.name === TEST_INSTANCE_NAME);
  
  const testInstance = {
    name: TEST_INSTANCE_NAME,
    port: TEST_PORT,
    enabled: false,
    description: "Test instance for restart",
    headers: null,
    hooks: null,
    forwards: [
      {
        name: "test-forward",
        target: "https://httpbin.org",
        enabled: true,
        description: "Test forward",
        path: "/",
        methods: ["*"],
        headers: null,
        hooks: null,
      },
    ],
    settings: null,
  };

  if (existingIndex >= 0) {
    config.instances[existingIndex] = testInstance;
  } else {
    config.instances.push(testInstance);
  }
  saveConfig(config);
  console.log(`[Setup] Test instance "${TEST_INSTANCE_NAME}" configured on port ${TEST_PORT}`);
}

async function cleanup() {
  const config = loadConfig();
  config.instances = config.instances.filter((i) => i.name !== TEST_INSTANCE_NAME);
  saveConfig(config);
  console.log(`[Cleanup] Test instance removed from config`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testRestartFlow() {
  const manager = new ProxyInstancesManager();

  console.log("\n=== Test 1: Start -> Stop -> Start ===\n");

  // 第一次启动
  console.log("[Test] Starting instance first time...");
  try {
    await manager.startInstance(TEST_INSTANCE_NAME);
    console.log("[Test] ✅ First start successful");
  } catch (error) {
    console.error("[Test] ❌ First start failed:", error);
    return false;
  }

  await sleep(1000);

  // 停止
  console.log("[Test] Stopping instance...");
  try {
    await manager.stopInstance(TEST_INSTANCE_NAME);
    console.log("[Test] ✅ Stop successful");
  } catch (error) {
    console.error("[Test] ❌ Stop failed:", error);
    return false;
  }

  await sleep(500);

  // 第二次启动（这里可能会有端口冲突问题）
  console.log("[Test] Starting instance second time...");
  try {
    await manager.startInstance(TEST_INSTANCE_NAME);
    console.log("[Test] ✅ Second start successful");
  } catch (error) {
    console.error("[Test] ❌ Second start failed:", error);
    return false;
  }

  // 清理
  console.log("[Test] Final cleanup...");
  try {
    await manager.stopInstance(TEST_INSTANCE_NAME);
    console.log("[Test] ✅ Final stop successful");
  } catch (error) {
    console.error("[Test] ❌ Final stop failed:", error);
  }

  return true;
}

async function testQuickRestart() {
  const manager = new ProxyInstancesManager();

  console.log("\n=== Test 2: Quick Restart (no delay) ===\n");

  // 启动
  console.log("[Test] Starting instance...");
  try {
    await manager.startInstance(TEST_INSTANCE_NAME);
    console.log("[Test] ✅ Start successful");
  } catch (error) {
    console.error("[Test] ❌ Start failed:", error);
    return false;
  }

  // 立即停止并重启（不等待）
  console.log("[Test] Quick stop and restart...");
  try {
    await manager.stopInstance(TEST_INSTANCE_NAME);
    // 不等待，立即重启
    await manager.startInstance(TEST_INSTANCE_NAME);
    console.log("[Test] ✅ Quick restart successful");
  } catch (error) {
    console.error("[Test] ❌ Quick restart failed:", error);
    return false;
  }

  // 清理
  try {
    await manager.stopInstance(TEST_INSTANCE_NAME);
  } catch {
    // ignore
  }

  return true;
}

async function main() {
  console.log("========================================");
  console.log("  Instance Restart Test");
  console.log("========================================\n");

  await setup();

  let allPassed = true;

  try {
    const test1 = await testRestartFlow();
    if (!test1) allPassed = false;

    const test2 = await testQuickRestart();
    if (!test2) allPassed = false;
  } finally {
    await cleanup();
  }

  console.log("\n========================================");
  if (allPassed) {
    console.log("  All tests passed! ✅");
  } else {
    console.log("  Some tests failed! ❌");
    process.exit(1);
  }
  console.log("========================================\n");
}

main().catch(console.error);
