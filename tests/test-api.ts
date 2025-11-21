/**
 * 测试新的高亮和格式化接口
 */

// 测试格式化接口
async function testFormat() {
  console.log("Testing /api/format...");

  const code = `const x=1;const y={a:1,b:2};function foo(){return x+y.a;}`;

  const response = await fetch("http://localhost:3002/api/format", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      filename: "test.js",
    }),
  });

  console.log("Response status:", response.status);
  const text = await response.text();
  console.log("Response text:", text);

  if (!text) {
    console.log("❌ Empty response");
    return;
  }

  const result = JSON.parse(text);

  if (result.success) {
    console.log("✅ Format successful!");
    console.log("Formatted code:");
    console.log(result.code);
  } else {
    console.log("❌ Format failed:", result.error);
  }
}

// 测试高亮接口
async function testHighlight() {
  console.log("\nTesting /api/highlight...");

  const code = `const x = 1;\nconsole.log(x);`;

  const response = await fetch("http://localhost:3002/api/highlight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      lang: "javascript",
      theme: "vitesse-dark",
    }),
  });

  const result = await response.json();

  if (result.success) {
    console.log("✅ Highlight successful!");
    console.log("HTML length:", result.html.length);
    console.log("First 100 chars:", result.html.substring(0, 100));
  } else {
    console.log("❌ Highlight failed:", result.error);
  }
}

// 测试 Worker.js 是否可访问
async function testWorkerJs() {
  console.log("\nTesting /worker.js...");

  const response = await fetch("http://localhost:3002/worker.js");

  if (response.ok) {
    const text = await response.text();
    console.log("✅ Worker.js accessible!");
    console.log("Size:", text.length, "bytes");
  } else {
    console.log("❌ Worker.js failed:", response.status, response.statusText);
  }
}

// 运行测试
async function runTests() {
  console.log("Starting API tests...\n");

  try {
    await testFormat();
    await testHighlight();
    await testWorkerJs();
    console.log("\n✅ All tests completed!");
  } catch (error) {
    console.error("\n❌ Test error:", error);
  }
}

runTests();
