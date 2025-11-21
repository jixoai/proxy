#!/usr/bin/env bun
import {
  generateFetchCode,
  generateNodeFetchCode,
} from "@/components/copy-as-fetch";
import type { RequestData } from "@/components/ProxyViewerContext";

// 模拟一个请求数据
const mockRequest: RequestData = {
  id: "1",
  folderName: "test",
  metadata: {
    timestamp: "2025-01-10T10:00:00Z",
    duration: "123ms",
    instanceId: 1,
    status: "completed",
    isWebSocket: false,
    websocketDirection: null,
    errorMessage: null,
    request: {
      method: "POST",
      url: "https://api.example.com/users",
      headersCount: 3,
      bodySize: 45,
    },
    response: {
      statusCode: 200,
      statusMessage: "OK",
      headersCount: 5,
      bodySize: 234,
    },
  },
  requestContent: `# 请求信息

- **方法**: POST
- **URL**: https://api.example.com/users
- **耗时**: 123ms

## 请求头

\`\`\`
content-type: application/json
accept: */*
user-agent: curl/8.0.0
\`\`\`

## 请求体

大小: 45 bytes

\`\`\`
{"name":"John Doe","email":"john@example.com"}
\`\`\`
`,
  requestBody: '{"name":"John Doe","email":"john@example.com"}',
};

console.log("=".repeat(80));
console.log("Testing Copy as Fetch Code Generation");
console.log("=".repeat(80));

console.log("\n🌐 Browser Fetch Code:");
console.log("-".repeat(80));
const browserCode = generateFetchCode(mockRequest);
console.log(browserCode);

console.log("\n\n🟢 Node.js Fetch Code:");
console.log("-".repeat(80));
const nodeCode = generateNodeFetchCode(mockRequest);
console.log(nodeCode);

console.log("\n" + "=".repeat(80));
console.log("✅ Test completed!");
console.log("=".repeat(80));
