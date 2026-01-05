#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { gunzipSync } from "node:zlib";
import * as path from "node:path";
import * as os from "node:os";

const DB_PATH = path.join(os.homedir(), ".jixo/.proxy/0.6.0/proxy.db");

function decodeDataUrl(dataUrl: string): string | null {
  if (!dataUrl) return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2], "base64");
    try { return buffer.toString("utf-8"); } catch {
      try { return gunzipSync(buffer).toString("utf-8"); } catch { return null; }
    }
  } catch { return null; }
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  
  console.log("=".repeat(80));
  console.log("RESPONSE COMPARISON: /gemini/v1/messages vs /droid/v1/messages");
  console.log("=".repeat(80));

  // 获取最新成功的 /gemini/v1/messages 响应
  const gemini = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all()[0];

  // 获取最新成功的 /droid/v1/messages 响应
  const droid = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/droid/v1/messages%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all()[0];

  if (!gemini) {
    console.log("No successful /gemini/v1/messages request found");
    return;
  }
  if (!droid) {
    console.log("No successful /droid/v1/messages request found");
    return;
  }

  const geminiData = JSON.parse(gemini.data);
  const droidData = JSON.parse(droid.data);

  console.log(`\nGemini request ID: ${gemini.id}`);
  console.log(`Droid request ID: ${droid.id}`);

  // 响应 headers
  console.log("\n### Response Headers ###");
  console.log("Gemini content-type:", geminiData.response?.headers?.["content-type"]);
  console.log("Droid content-type:", droidData.response?.headers?.["content-type"]);

  // 响应体
  const geminiResp = decodeDataUrl(geminiData.response?.bodyDataUrl);
  const droidResp = decodeDataUrl(droidData.response?.bodyDataUrl);

  console.log("\n### Response Body Format ###");
  console.log("Gemini response length:", geminiResp?.length);
  console.log("Droid response length:", droidResp?.length);

  // 检查是否是 SSE
  const geminiIsSSE = geminiResp?.startsWith("data:");
  const droidIsSSE = droidResp?.startsWith("data:");
  console.log("Gemini is SSE:", geminiIsSSE);
  console.log("Droid is SSE:", droidIsSSE);

  // 解析 SSE 事件
  if (geminiIsSSE && geminiResp) {
    console.log("\n### Gemini SSE Events (first 5) ###");
    const events = geminiResp.split("\n\n").filter(e => e.startsWith("data:")).slice(0, 5);
    for (let i = 0; i < events.length; i++) {
      const data = events[i].replace("data: ", "");
      try {
        const parsed = JSON.parse(data);
        console.log(`\nEvent ${i + 1}:`, JSON.stringify(parsed, null, 2).substring(0, 800));
      } catch {
        console.log(`\nEvent ${i + 1} (raw):`, data.substring(0, 500));
      }
    }
  }

  if (droidIsSSE && droidResp) {
    console.log("\n### Droid SSE Events (first 5) ###");
    const events = droidResp.split("\n\n").filter(e => e.startsWith("data:")).slice(0, 5);
    for (let i = 0; i < events.length; i++) {
      const data = events[i].replace("data: ", "");
      try {
        const parsed = JSON.parse(data);
        console.log(`\nEvent ${i + 1}:`, JSON.stringify(parsed, null, 2).substring(0, 800));
      } catch {
        console.log(`\nEvent ${i + 1} (raw):`, data.substring(0, 500));
      }
    }
  }

  // 查找工具调用相关的事件
  if (geminiResp) {
    console.log("\n### Gemini Tool Call Events ###");
    const events = geminiResp.split("\n\n").filter(e => e.startsWith("data:"));
    let foundToolCall = false;
    for (const event of events) {
      const data = event.replace("data: ", "");
      if (data.includes("functionCall") || data.includes("function_call") || data.includes("tool")) {
        try {
          const parsed = JSON.parse(data);
          console.log("Tool event:", JSON.stringify(parsed, null, 2).substring(0, 1500));
          foundToolCall = true;
          break;
        } catch {}
      }
    }
    if (!foundToolCall) {
      console.log("No tool call events found in Gemini response");
    }
  }

  if (droidResp) {
    console.log("\n### Droid Tool Call Events ###");
    const events = droidResp.split("\n\n").filter(e => e.startsWith("data:"));
    let foundToolCall = false;
    for (const event of events) {
      const data = event.replace("data: ", "");
      if (data.includes("tool_use") || data.includes("tool_call")) {
        try {
          const parsed = JSON.parse(data);
          console.log("Tool event:", JSON.stringify(parsed, null, 2).substring(0, 1500));
          foundToolCall = true;
          break;
        } catch {}
      }
    }
    if (!foundToolCall) {
      console.log("No tool call events found in Droid response");
    }
  }

  db.close();
}

main().catch(console.error);
