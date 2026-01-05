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
  
  // 获取最新的成功 v1beta 请求
  console.log("=".repeat(80));
  console.log("FULL COMPARISON: v1beta (success) vs v1/messages (fail)");
  console.log("=".repeat(80));

  const v1beta = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1beta/%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all()[0];

  const v1msg = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code != 200
    ORDER BY id DESC LIMIT 1
  `).all()[0];

  if (!v1beta || !v1msg) {
    console.log("Missing data");
    return;
  }

  const betaData = JSON.parse(v1beta.data);
  const msgData = JSON.parse(v1msg.data);

  // 1. 基本信息
  console.log("\n### 1. Basic Info ###");
  console.log(`v1beta ID: ${v1beta.id}, Status: ${betaData.response?.statusCode || 'N/A'}`);
  console.log(`v1/messages ID: ${v1msg.id}, Status: ${msgData.response?.statusCode || 'N/A'}`);

  // 2. 请求 URL
  console.log("\n### 2. Request URLs ###");
  console.log(`v1beta original: ${betaData.request?.url}`);
  console.log(`v1beta target: ${betaData.request?.targetUrl}`);
  console.log(`v1/messages original: ${msgData.request?.url}`);
  console.log(`v1/messages target: ${msgData.request?.targetUrl}`);
  if (msgData.hookedRequest) {
    console.log(`v1/messages hooked URL: ${msgData.hookedRequest?.url}`);
  }

  // 3. 原始请求 Headers 对比
  console.log("\n### 3. Original Request Headers ###");
  const betaOrigHeaders = betaData.request?.headers || {};
  const msgOrigHeaders = msgData.request?.headers || {};
  
  const allOrigKeys = new Set([...Object.keys(betaOrigHeaders), ...Object.keys(msgOrigHeaders)]);
  console.log("| Header | v1beta | v1/messages |");
  console.log("|--------|--------|-------------|");
  for (const key of [...allOrigKeys].sort()) {
    const bv = betaOrigHeaders[key] || "(none)";
    const mv = msgOrigHeaders[key] || "(none)";
    const bvShort = typeof bv === 'string' ? bv.substring(0, 40) : JSON.stringify(bv).substring(0, 40);
    const mvShort = typeof mv === 'string' ? mv.substring(0, 40) : JSON.stringify(mv).substring(0, 40);
    if (bv !== mv) {
      console.log(`| **${key}** | ${bvShort} | ${mvShort} |`);
    }
  }

  // 4. Forwarded Headers 对比
  console.log("\n### 4. Forwarded Headers (sent to upstream) ###");
  const betaFwdHeaders = betaData.request?.forwardedHeaders || {};
  const msgFwdHeaders = msgData.request?.forwardedHeaders || {};
  
  const allFwdKeys = new Set([...Object.keys(betaFwdHeaders), ...Object.keys(msgFwdHeaders)]);
  console.log("| Header | v1beta | v1/messages |");
  console.log("|--------|--------|-------------|");
  for (const key of [...allFwdKeys].sort()) {
    const bv = betaFwdHeaders[key] || "(none)";
    const mv = msgFwdHeaders[key] || "(none)";
    const bvShort = typeof bv === 'string' ? bv.substring(0, 40) : JSON.stringify(bv).substring(0, 40);
    const mvShort = typeof mv === 'string' ? mv.substring(0, 40) : JSON.stringify(mv).substring(0, 40);
    const diff = bv !== mv ? "**DIFF**" : "";
    console.log(`| ${key} ${diff} | ${bvShort} | ${mvShort} |`);
  }

  // 5. Hooked Headers (v1/messages only)
  if (msgData.hookedRequest?.headers) {
    console.log("\n### 5. Hooked Request Headers (v1/messages plugin output) ###");
    const hookedHeaders = msgData.hookedRequest.headers;
    console.log("| Header | Value |");
    console.log("|--------|-------|");
    for (const [key, val] of Object.entries(hookedHeaders).sort()) {
      const v = typeof val === 'string' ? val.substring(0, 60) : JSON.stringify(val).substring(0, 60);
      console.log(`| ${key} | ${v} |`);
    }
  }

  // 6. 请求 Body 对比
  console.log("\n### 6. Request Body Structure ###");
  const betaBody = decodeDataUrl(betaData.request?.bodyDataUrl);
  const msgBody = decodeDataUrl(msgData.request?.bodyDataUrl);
  const hookedBody = msgData.hookedRequest ? decodeDataUrl(msgData.hookedRequest.bodyDataUrl) : null;

  if (betaBody) {
    try {
      const parsed = JSON.parse(betaBody);
      console.log("v1beta body keys:", Object.keys(parsed));
      console.log("v1beta body.contents length:", parsed.contents?.length);
      console.log("v1beta has systemInstruction:", !!parsed.systemInstruction || !!parsed.system_instruction);
    } catch {}
  }

  if (msgBody) {
    try {
      const parsed = JSON.parse(msgBody);
      console.log("v1/messages original body keys:", Object.keys(parsed));
    } catch {}
  }

  if (hookedBody) {
    try {
      const parsed = JSON.parse(hookedBody);
      console.log("v1/messages hooked body keys:", Object.keys(parsed));
      console.log("v1/messages hooked body.contents length:", parsed.contents?.length);
      console.log("v1/messages hooked has system_instruction:", !!parsed.system_instruction);
    } catch {}
  }

  // 7. 关键差异总结
  console.log("\n### 7. Key Differences Summary ###");
  
  // 检查 v1beta forwarded 中有但 v1/messages hooked 中没有的
  const hookedHeaders = msgData.hookedRequest?.headers || {};
  const missingInHooked = Object.keys(betaFwdHeaders).filter(k => 
    !hookedHeaders[k] && !k.startsWith('-x-jixo')
  );
  const extraInHooked = Object.keys(hookedHeaders).filter(k => 
    !betaFwdHeaders[k] && !k.startsWith('-x-jixo')
  );
  
  console.log("Headers in v1beta but missing in v1/messages hooked:", missingInHooked);
  console.log("Headers in v1/messages hooked but not in v1beta:", extraInHooked);

  // 8. 实际发送的请求对比
  console.log("\n### 8. What was actually sent? ###");
  console.log("v1beta: Uses forwardedHeaders directly (no hooks)");
  console.log("v1/messages: Should use hookedRequest.headers (after plugin)");
  
  // 检查 proxy 是否真的使用了 hooked headers
  if (msgData.hookedRequest) {
    console.log("\nv1/messages hookedRequest exists: YES");
    console.log("hookedRequest.url:", msgData.hookedRequest.url);
  }

  db.close();
}

main().catch(console.error);
