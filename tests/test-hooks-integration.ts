#!/usr/bin/env bun
/**
 * 集成测试：验证 HooksExecutor 与 HTTP hook 进程的通讯
 */

import { HooksExecutor } from "../src/lib/hooks-executor";
import type { HooksConfig } from "../src/types/proxy";

async function main() {
  console.log("=== 测试 HooksExecutor HTTP 通讯 ===\n");

  const hooksConfig: HooksConfig = {
    request: {
      type: "http",
      command: "bun",
      args: ["test-hook-http.ts"],
      cwd: import.meta.dirname,
    },
  };

  const executor = new HooksExecutor("test-instance", hooksConfig);

  console.log("1. 启动 HooksExecutor...");
  await executor.start();
  console.log("   ✓ 启动成功\n");

  console.log("2. 测试 request hook...");
  const testBody = Buffer.from(JSON.stringify({ message: "Hello World" }));
  const result = await executor.executeRequestHooks({
    method: "POST",
    url: "https://api.example.com/test",
    headers: { "content-type": "application/json" },
    body: testBody,
  });

  console.log("   Request hook 结果:");
  console.log(`   - method: ${result.method}`);
  console.log(`   - url: ${result.url}`);
  console.log(`   - headers: ${JSON.stringify(result.headers)}`);
  console.log(`   - body length: ${result.body.length}`);
  console.log(`   - body matches: ${result.body.equals(testBody)}`);
  console.log("   ✓ Request hook 测试完成\n");

  console.log("3. 停止 HooksExecutor...");
  await executor.stop();
  console.log("   ✓ 停止成功\n");

  console.log("=== 所有测试通过 ===");
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
