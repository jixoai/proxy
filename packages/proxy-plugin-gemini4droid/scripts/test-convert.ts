#!/usr/bin/env bun
import { convertRequest, isDroidRequest, convertHeaders } from "../src/request-converter";

// 模拟 429 请求的 headers 和 body
const anthropicHeaders = {
  "host": "127.0.0.1:20002",
  "user-agent": "factory-cli/0.41.0",
  "accept": "application/json",
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
  "x-api-key": "your-secret-key",
};

const anthropicBody = {
  model: "gemini-2.5-pro",
  max_tokens: 16000,
  stream: true,
  system: "You are Droid, an AI software engineering agent built by Factory.",
  messages: [
    { role: "user", content: "Hello" }
  ],
  tools: []
};

console.log("=== Test isDroidRequest ===");
console.log("Is Droid request?", isDroidRequest(anthropicBody));

console.log("\n=== Test convertHeaders ===");
const geminiHeaders = convertHeaders(anthropicHeaders, { model: anthropicBody.model });
console.log("Input headers:", JSON.stringify(anthropicHeaders, null, 2));
console.log("Output headers:", JSON.stringify(geminiHeaders, null, 2));

console.log("\n=== Test convertRequest ===");
const result = convertRequest({
  headers: anthropicHeaders,
  body: JSON.stringify(anthropicBody),
  upstreamBaseUrl: "https://www.88code.ai/v1beta",
});

console.log("Result URL:", result.url);
console.log("Result Headers:", JSON.stringify(result.headers, null, 2));
console.log("Result Body (preview):", result.body?.substring(0, 500));

// 解析 body 检查格式
if (result.body) {
  const parsed = JSON.parse(result.body);
  console.log("\nConverted body keys:", Object.keys(parsed));
  console.log("Has 'contents'?", !!parsed.contents);
  console.log("Has 'messages'?", !!parsed.messages);
}
