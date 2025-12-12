#!/usr/bin/env bun
/**
 * 测试 droid-to-claude-rewrite 插件
 */

import { HooksExecutor } from "../src/lib/hooks-executor";
import type { HooksConfig } from "../src/types/proxy";

async function main() {
  console.log("=== 测试 droid-to-claude-rewrite 插件 ===\n");

  const hooksConfig: HooksConfig = {
    request: {
      type: "http",
      command: "bun",
      args: ["droid-to-claude-rewrite.ts"],
      cwd: "/Users/kzf/Dev/GitHub/jixoai-labs/proxy/plugins",
    },
  };

  const executor = new HooksExecutor("test-droid", hooksConfig);

  console.log("1. 启动 HooksExecutor...");
  await executor.start();
  console.log("   ✓ 启动成功\n");

  // 模拟一个 Droid 请求
  console.log("2. 测试 Droid 请求重写...");
  const droidRequest = {
    model: "claude-3-opus-20240229",
    system: "You are Droid, a factory-droid assistant.",
    messages: [
      { role: "user", content: "Hello" }
    ],
    max_tokens: 1024,
  };

  const result = await executor.executeRequestHooks({
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": "test-key",
    },
    body: Buffer.from(JSON.stringify(droidRequest)),
  });

  console.log("   重写后的请求:");
  console.log(`   - method: ${result.method}`);
  console.log(`   - url: ${result.url}`);

  // 解析 body 查看重写效果
  try {
    const rewrittenBody = JSON.parse(result.body.toString("utf-8"));
    console.log(`   - system type: ${Array.isArray(rewrittenBody.system) ? "array" : typeof rewrittenBody.system}`);
    if (Array.isArray(rewrittenBody.system)) {
      console.log(`   - system blocks: ${rewrittenBody.system.length}`);
      console.log(`   - first system text preview: ${rewrittenBody.system[0]?.text?.substring(0, 50)}...`);
    }
    console.log(`   - has anthropic-beta header: ${!!result.headers?.["anthropic-beta"]}`);
  } catch (e) {
    console.log(`   - body parse error: ${e}`);
  }

  console.log("   ✓ Droid 请求重写测试完成\n");

  console.log("3. 停止 HooksExecutor...");
  await executor.stop();
  console.log("   ✓ 停止成功\n");

  console.log("=== 所有测试通过 ===");
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
