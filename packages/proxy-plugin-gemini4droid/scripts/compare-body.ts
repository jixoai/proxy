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

function compareObjects(a: any, b: any, path = ""): string[] {
  const diffs: string[] = [];
  const aKeys = new Set(Object.keys(a || {}));
  const bKeys = new Set(Object.keys(b || {}));
  
  for (const key of aKeys) {
    if (!bKeys.has(key)) {
      diffs.push(`${path}${key}: v1beta has, v1/messages missing`);
    }
  }
  for (const key of bKeys) {
    if (!aKeys.has(key)) {
      diffs.push(`${path}${key}: v1/messages has, v1beta missing`);
    }
  }
  return diffs;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  
  // 获取最新请求
  const v1beta = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1beta/%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all()[0];

  const v1msg = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%'
    ORDER BY id DESC LIMIT 1
  `).all()[0];

  if (!v1beta || !v1msg) {
    console.log("Missing data");
    return;
  }

  const betaData = JSON.parse(v1beta.data);
  const msgData = JSON.parse(v1msg.data);

  console.log("=".repeat(80));
  console.log("BODY COMPARISON: v1beta vs v1/messages");
  console.log("=".repeat(80));
  console.log(`v1beta ID: ${v1beta.id}, v1/messages ID: ${v1msg.id} (status: ${msgData.response?.statusCode})`);

  // v1beta body (原始 Gemini 格式)
  const betaBody = decodeDataUrl(betaData.request?.bodyDataUrl);
  // v1/messages hooked body (转换后的 Gemini 格式)
  const hookedBody = msgData.hookedRequest 
    ? decodeDataUrl(msgData.hookedRequest.bodyDataUrl)
    : null;

  let betaParsed: any = null;
  let hookedParsed: any = null;

  if (betaBody) {
    try { betaParsed = JSON.parse(betaBody); } catch {}
  }
  if (hookedBody) {
    try { hookedParsed = JSON.parse(hookedBody); } catch {}
  }

  console.log("\n### Top-Level Keys ###");
  console.log("v1beta:", Object.keys(betaParsed || {}));
  console.log("v1/messages hooked:", Object.keys(hookedParsed || {}));

  // 比较 key 差异
  const keyDiffs = compareObjects(betaParsed, hookedParsed);
  if (keyDiffs.length > 0) {
    console.log("\n### Key Differences ###");
    keyDiffs.forEach(d => console.log(`  - ${d}`));
  }

  // 详细比较每个字段
  console.log("\n### Field Comparison ###");
  
  // contents
  console.log("\n--- contents ---");
  console.log("v1beta contents length:", betaParsed?.contents?.length);
  console.log("v1/messages contents length:", hookedParsed?.contents?.length);
  if (betaParsed?.contents?.[0]) {
    console.log("v1beta first content role:", betaParsed.contents[0].role);
    console.log("v1beta first content parts count:", betaParsed.contents[0].parts?.length);
  }
  if (hookedParsed?.contents?.[0]) {
    console.log("v1/messages first content role:", hookedParsed.contents[0].role);
    console.log("v1/messages first content parts count:", hookedParsed.contents[0].parts?.length);
  }

  // systemInstruction vs system_instruction
  console.log("\n--- system instruction ---");
  console.log("v1beta has 'systemInstruction':", !!betaParsed?.systemInstruction);
  console.log("v1beta has 'system_instruction':", !!betaParsed?.system_instruction);
  console.log("v1/messages has 'systemInstruction':", !!hookedParsed?.systemInstruction);
  console.log("v1/messages has 'system_instruction':", !!hookedParsed?.system_instruction);

  // tools
  console.log("\n--- tools ---");
  console.log("v1beta tools:", betaParsed?.tools ? JSON.stringify(betaParsed.tools).substring(0, 200) : "(none)");
  console.log("v1/messages tools:", hookedParsed?.tools ? JSON.stringify(hookedParsed.tools).substring(0, 200) : "(none)");
  
  // generationConfig vs generation_config
  console.log("\n--- generation config ---");
  console.log("v1beta 'generationConfig':", JSON.stringify(betaParsed?.generationConfig));
  console.log("v1beta 'generation_config':", JSON.stringify(betaParsed?.generation_config));
  console.log("v1/messages 'generationConfig':", JSON.stringify(hookedParsed?.generationConfig));
  console.log("v1/messages 'generation_config':", JSON.stringify(hookedParsed?.generation_config));

  // 完整 body 对比 (结构)
  console.log("\n### Full Body Structure ###");
  console.log("\nv1beta body (first 1500 chars):");
  console.log(JSON.stringify(betaParsed, null, 2).substring(0, 1500));
  console.log("\nv1/messages hooked body (first 1500 chars):");
  console.log(JSON.stringify(hookedParsed, null, 2).substring(0, 1500));

  db.close();
}

main().catch(console.error);
