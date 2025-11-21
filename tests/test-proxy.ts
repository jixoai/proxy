#!/usr/bin/env bun

/**
 * 代理服务器功能测试脚本
 *
 * 使用方法：
 * 1. 启动 viewer-server: bun src/viewer-server.ts
 * 2. 运行此测试: bun test-proxy.ts
 */

console.log("\n🧪 代理服务器功能测试\n");
console.log("=".repeat(60));

// 等待函数
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 测试配置
const PROXY_PORT = 10001;
const VIEWER_PORT = 3001;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;
const VIEWER_API = `http://localhost:${VIEWER_PORT}/api`;

let testsPassed = 0;
let testsFailed = 0;

// 测试辅助函数
async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n📝 测试: ${name}...`);
  try {
    await fn();
    console.log(" ✅ 通过");
    testsPassed++;
  } catch (error) {
    console.log(" ❌ 失败");
    console.error(`   错误: ${error instanceof Error ? error.message : String(error)}`);
    testsFailed++;
  }
}

// 检查服务状态
async function checkService(name: string, url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    if (response.ok) {
      console.log(`✓ ${name} 运行正常 (${url})`);
      return true;
    }
    console.error(`✗ ${name} 响应异常: ${response.status}`);
    return false;
  } catch (error) {
    console.error(`✗ ${name} 无法连接: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// 获取最新的请求记录
async function getLatestRequest(): Promise<any> {
  await sleep(500); // 等待数据库写入和 UDP 通知
  const response = await fetch(`${VIEWER_API}/requests`);
  const requests = await response.json();
  return requests[0]; // 最新的请求在第一个
}

// 主测试流程
async function runTests() {
  console.log("\n📡 1. 检查服务状态");
  console.log("-".repeat(60));

  const viewerRunning = await checkService("Viewer Server", `${VIEWER_API}/instances`);

  if (!viewerRunning) {
    console.error("\n❌ Viewer Server 未运行，请先启动:");
    console.error("   bun src/viewer-server.ts\n");
    process.exit(1);
  }

  // 检查代理实例状态
  const instancesRes = await fetch(`${VIEWER_API}/instances`);
  const instances = await instancesRes.json();
  console.log(`\n找到 ${instances.length} 个代理实例:`);
  for (const inst of instances) {
    console.log(`  - ${inst.name} (端口 ${inst.port})`);
  }

  if (instances.length === 0) {
    console.error("\n❌ 没有代理实例，请在 viewer UI 中创建\n");
    process.exit(1);
  }

  console.log("\n🔬 2. 功能测试");
  console.log("-".repeat(60));

  // Test 1: 简单 HTTP GET 请求
  await test("简单 HTTP GET 请求 (pending → completed)", async () => {
    const response = await fetch(`${PROXY_URL}/get`, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }

    const data = await response.json();
    console.log(`\n     响应: ${JSON.stringify(data).substring(0, 100)}...`);

    // 检查数据库记录
    const record = await getLatestRequest();
    if (!record) throw new Error("未找到请求记录");

    console.log(`     数据库记录: ID=${record.id}, 状态=${record.metadata.status}`);

    if (record.metadata.status !== "completed") {
      throw new Error(`状态错误: 期望 completed, 实际 ${record.metadata.status}`);
    }

    if (!record.metadata.response || record.metadata.response.statusCode !== 200) {
      throw new Error(`响应码错误: ${record.metadata.response?.statusCode}`);
    }
  });

  // Test 2: POST 请求
  await test("POST 请求with JSON body", async () => {
    const testBody = { test: "data", timestamp: Date.now() };
    const response = await fetch(`${PROXY_URL}/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testBody),
    });

    if (!response.ok) throw new Error(`请求失败: ${response.status}`);

    const record = await getLatestRequest();
    if (record.metadata.request.method !== "POST") {
      throw new Error(`方法错误: ${record.metadata.request.method}`);
    }

    if (record.metadata.request.bodySize === 0) {
      throw new Error("请求体未记录");
    }

    console.log(`\n     请求体大小: ${record.metadata.request.bodySize} bytes`);
  });

  // Test 3: 错误处理
  await test("错误处理 (error 状态)", async () => {
    try {
      // 请求一个不存在的主机
      await fetch(`${PROXY_URL}/status/500`, {
        method: "GET",
      });
    } catch (error) {
      // 预期会失败
    }

    await sleep(1000); // 等待错误记录

    const record = await getLatestRequest();

    // 可能是 error 或 completed(500)
    if (record.metadata.status === "error") {
      console.log(`\n     错误消息: ${record.metadata.errorMessage}`);
    } else if (record.metadata.response?.statusCode === 500) {
      console.log(`\n     收到 500 错误响应`);
    } else {
      throw new Error(`未正确处理错误: 状态=${record.metadata.status}`);
    }
  });

  // Test 4: WebSocket 状态标识
  await test("WebSocket 标识检查", async () => {
    const response = await fetch(`${VIEWER_API}/requests`);
    const requests = await response.json();

    const hasWebSocketFlag = requests.every((req: any) =>
      typeof req.metadata.isWebSocket === "boolean"
    );

    if (!hasWebSocketFlag) {
      throw new Error("请求记录缺少 isWebSocket 字段");
    }

    console.log(`\n     所有请求都有 isWebSocket 字段`);
  });

  // Test 5: 实时推送 WebSocket 连接测试
  await test("WebSocket 推送通知", async () => {
    return new Promise(async (resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${VIEWER_PORT}/ws`);
      let messageReceived = false;

      ws.onopen = async () => {
        console.log(`\n     WebSocket 已连接`);

        // 发起一个请求
        await fetch(`${PROXY_URL}/get?test=websocket`, { method: "GET" });
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log(`\n     收到消息类型: ${message.type}`);

          if (message.type === "new-request" || message.type === "update-request") {
            messageReceived = true;
            ws.close();
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      };

      ws.onerror = (error) => {
        reject(new Error("WebSocket 连接失败"));
      };

      ws.onclose = () => {
        if (!messageReceived) {
          reject(new Error("未收到推送通知"));
        }
      };

      // 超时保护
      setTimeout(() => {
        if (!messageReceived) {
          ws.close();
          reject(new Error("WebSocket 推送超时"));
        }
      }, 5000);
    });
  });

  // Test 6: 清除功能
  await test("清除所有请求", async () => {
    const clearResponse = await fetch(`${VIEWER_API}/clear`, { method: "POST" });
    if (!clearResponse.ok) throw new Error("清除失败");

    await sleep(500);

    const response = await fetch(`${VIEWER_API}/requests`);
    const requests = await response.json();

    if (requests.length !== 0) {
      throw new Error(`清除后仍有 ${requests.length} 条记录`);
    }

    console.log(`\n     成功清除所有请求记录`);
  });

  // 测试总结
  console.log("\n" + "=".repeat(60));
  console.log("\n📊 测试总结:");
  console.log(`   ✅ 通过: ${testsPassed}`);
  console.log(`   ❌ 失败: ${testsFailed}`);
  console.log(`   📈 成功率: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%\n`);

  if (testsFailed === 0) {
    console.log("🎉 所有测试通过！\n");
    process.exit(0);
  } else {
    console.log("⚠️  部分测试失败，请检查日志\n");
    process.exit(1);
  }
}

// 启动测试
runTests().catch((error) => {
  console.error("\n❌ 测试运行失败:", error);
  process.exit(1);
});
