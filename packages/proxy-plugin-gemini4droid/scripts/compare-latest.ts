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
  
  // 最新的 v1beta 请求
  console.log("=== Latest /gemini/v1beta/models Requests ===");
  const v1beta = db.query<any, []>(`
    SELECT id, request_url, status_code, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1beta/models/%'
    ORDER BY id DESC LIMIT 2
  `).all();

  for (const row of v1beta) {
    console.log(`\n--- Request ${row.id} (${row.status_code}) ---`);
    console.log(`URL: ${row.request_url}`);
    const data = JSON.parse(row.data);
    
    console.log("\nRequest Headers:");
    console.log(JSON.stringify(data.request?.headers, null, 2));
    
    console.log("\nForwarded Headers:");
    console.log(JSON.stringify(data.request?.forwardedHeaders, null, 2));
    
    if (data.hookedRequest) {
      console.log("\nHooked Request Headers:");
      console.log(JSON.stringify(data.hookedRequest?.headers, null, 2));
    }
    
    // 响应体
    if (data.response?.bodyDataUrl && row.status_code !== 200) {
      const respBody = decodeDataUrl(data.response.bodyDataUrl);
      if (respBody) {
        console.log("\nResponse Body:", respBody.substring(0, 500));
      }
    }
  }

  // 最新的 429 请求
  console.log("\n\n=== Latest 429 /gemini/v1/messages Request ===");
  const error429 = db.query<any, []>(`
    SELECT id, request_url, status_code, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code = 429
    ORDER BY id DESC LIMIT 1
  `).all();

  for (const row of error429) {
    console.log(`\n--- Request ${row.id} (${row.status_code}) ---`);
    console.log(`URL: ${row.request_url}`);
    const data = JSON.parse(row.data);
    
    console.log("\nRequest Headers:");
    console.log(JSON.stringify(data.request?.headers, null, 2));
    
    console.log("\nForwarded Headers:");
    console.log(JSON.stringify(data.request?.forwardedHeaders, null, 2));
    
    if (data.hookedRequest) {
      console.log("\nHooked Request Headers:");
      console.log(JSON.stringify(data.hookedRequest?.headers, null, 2));
    }
    
    // 响应体
    if (data.response?.bodyDataUrl) {
      const respBody = decodeDataUrl(data.response.bodyDataUrl);
      if (respBody) {
        console.log("\nResponse Body:", respBody.substring(0, 500));
      }
    }
  }

  // 关键对比
  console.log("\n\n=== Key Comparison ===");
  if (v1beta[0] && error429[0]) {
    const v1betaData = JSON.parse(v1beta[0].data);
    const errData = JSON.parse(error429[0].data);
    
    const v1betaHeaders = v1betaData.request?.headers || {};
    const errHeaders = errData.request?.headers || {};
    const errForwarded = errData.request?.forwardedHeaders || {};
    const errHooked = errData.hookedRequest?.headers || {};
    
    console.log("\n| Header | v1beta (成功) | 429 forwarded | 429 hooked |");
    console.log("|--------|--------------|---------------|------------|");
    
    const keys = ['x-goog-api-key', 'authorization', 'x-api-key', 'user-agent', 'x-goog-api-client'];
    for (const k of keys) {
      const v1 = v1betaHeaders[k] ? v1betaHeaders[k].substring(0, 30) + '...' : '(无)';
      const fwd = errForwarded[k] ? errForwarded[k].substring(0, 30) + '...' : '(无)';
      const hk = errHooked[k] ? errHooked[k].substring(0, 30) + '...' : '(无)';
      console.log(`| ${k} | ${v1} | ${fwd} | ${hk} |`);
    }
  }

  db.close();
}

main().catch(console.error);
