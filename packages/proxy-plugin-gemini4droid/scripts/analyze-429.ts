#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { gunzipSync } from "node:zlib";
import * as path from "node:path";
import * as os from "node:os";

const DB_PATH = path.join(os.homedir(), ".jixo/.proxy/0.6.0/proxy.db");

interface ProxyRequest {
  id: number;
  request_url: string;
  status_code: number;
  data: string;
}

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
  
  // 统计状态码
  console.log("=== /gemini/v1/messages Status ===");
  const v1MsgStats = db.query<{ status_code: number; count: number }, []>(`
    SELECT status_code, COUNT(*) as count FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' GROUP BY status_code ORDER BY count DESC
  `).all();
  console.table(v1MsgStats);

  console.log("\n=== /gemini/v1beta/models/ Status ===");
  const v1betaStats = db.query<{ status_code: number; count: number }, []>(`
    SELECT status_code, COUNT(*) as count FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1beta/models/%' GROUP BY status_code ORDER BY count DESC
  `).all();
  console.table(v1betaStats);

  // 429 请求详情
  console.log("\n=== 429 Request Details ===");
  const error429 = db.query<ProxyRequest, []>(`
    SELECT id, request_url, status_code, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code = 429
    ORDER BY id DESC LIMIT 3
  `).all();

  for (const row of error429) {
    console.log(`\n--- Request ${row.id} (429) ---`);
    console.log(`URL: ${row.request_url}`);
    const data = JSON.parse(row.data);
    console.log("Request Headers:", JSON.stringify(data.request?.headers, null, 2));
    
    if (data.response?.bodyDataUrl) {
      const respBody = decodeDataUrl(data.response.bodyDataUrl);
      console.log("Response Body:", respBody?.substring(0, 500));
    }
    if (data.response?.headers) {
      console.log("Response Headers:", JSON.stringify(data.response.headers, null, 2));
    }
  }

  // 成功的 v1beta 请求
  console.log("\n=== Successful v1beta Request ===");
  const successV1beta = db.query<ProxyRequest, []>(`
    SELECT id, request_url, status_code, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1beta/models/%:streamGenerateContent%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all();

  for (const row of successV1beta) {
    console.log(`\n--- Request ${row.id} (200) ---`);
    console.log(`URL: ${row.request_url}`);
    const data = JSON.parse(row.data);
    console.log("Request Headers:", JSON.stringify(data.request?.headers, null, 2));
  }

  // 成功的 v1/messages 请求对比
  console.log("\n=== Successful v1/messages Request ===");
  const successV1Msg = db.query<ProxyRequest, []>(`
    SELECT id, request_url, status_code, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all();

  for (const row of successV1Msg) {
    console.log(`\n--- Request ${row.id} (200) ---`);
    console.log(`URL: ${row.request_url}`);
    const data = JSON.parse(row.data);
    console.log("Request Headers:", JSON.stringify(data.request?.headers, null, 2));
  }

  // URL 对比
  console.log("\n=== URL Patterns ===");
  console.log("v1/messages:");
  db.query<{ request_url: string }, []>(`SELECT DISTINCT request_url FROM proxy_requests WHERE request_url LIKE '%/gemini/v1/messages%' LIMIT 3`).all().forEach(r => console.log(`  ${r.request_url}`));
  console.log("\nv1beta:");
  db.query<{ request_url: string }, []>(`SELECT DISTINCT request_url FROM proxy_requests WHERE request_url LIKE '%/gemini/v1beta/models/%' LIMIT 3`).all().forEach(r => console.log(`  ${r.request_url}`));

  db.close();
}

main().catch(console.error);
