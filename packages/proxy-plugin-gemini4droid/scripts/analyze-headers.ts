#!/usr/bin/env bun
/**
 * 分析 /gemini/v1beta/models/ 和 /gemini/v1/messages 请求头差异
 */

import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as os from "node:os";

const DB_PATH = path.join(os.homedir(), ".jixo/.proxy/0.6.0/proxy.db");

interface ProxyRequest {
  id: number;
  request_url: string;
  status_code: number;
  data: string;
}

interface RequestData {
  request?: {
    bodyDataUrl?: string;
    headers?: Record<string, string>;
  };
  response?: {
    bodyDataUrl?: string;
    statusCode?: number;
    headers?: Record<string, string>;
  };
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  
  // 获取 v1beta 请求
  const v1betaRows = db.query<ProxyRequest, []>(`
    SELECT id, request_url, status_code, data 
    FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1beta/models/%' 
    ORDER BY id DESC 
    LIMIT 5
  `).all();
  
  // 获取 v1/messages 请求
  const v1MessagesRows = db.query<ProxyRequest, []>(`
    SELECT id, request_url, status_code, data 
    FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' 
    ORDER BY id DESC 
    LIMIT 5
  `).all();
  
  console.log("=== /gemini/v1beta/models/ Request Headers ===");
  console.log(`Found ${v1betaRows.length} requests\n`);
  
  for (const row of v1betaRows.slice(0, 2)) {
    const data: RequestData = JSON.parse(row.data);
    console.log(`--- Request ${row.id} (status: ${row.status_code}) ---`);
    console.log(`URL: ${row.request_url}`);
    console.log("Request Headers:");
    console.log(JSON.stringify(data.request?.headers, null, 2));
    console.log("Response Headers:");
    console.log(JSON.stringify(data.response?.headers, null, 2));
    console.log();
  }
  
  console.log("\n=== /gemini/v1/messages Request Headers ===");
  console.log(`Found ${v1MessagesRows.length} requests\n`);
  
  for (const row of v1MessagesRows.slice(0, 2)) {
    const data: RequestData = JSON.parse(row.data);
    console.log(`--- Request ${row.id} (status: ${row.status_code}) ---`);
    console.log(`URL: ${row.request_url}`);
    console.log("Request Headers:");
    console.log(JSON.stringify(data.request?.headers, null, 2));
    console.log("Response Headers:");
    console.log(JSON.stringify(data.response?.headers, null, 2));
    console.log();
  }
  
  // 比较 headers 差异
  console.log("\n=== Headers Comparison ===");
  if (v1betaRows[0] && v1MessagesRows[0]) {
    const v1betaHeaders = JSON.parse(v1betaRows[0].data).request?.headers || {};
    const v1MsgHeaders = JSON.parse(v1MessagesRows[0].data).request?.headers || {};
    
    const allKeys = new Set([...Object.keys(v1betaHeaders), ...Object.keys(v1MsgHeaders)]);
    
    console.log("\nHeader Key | v1beta | v1/messages");
    console.log("-".repeat(80));
    for (const key of [...allKeys].sort()) {
      const v1beta = v1betaHeaders[key] || "(missing)";
      const v1msg = v1MsgHeaders[key] || "(missing)";
      if (v1beta !== v1msg) {
        console.log(`${key}:`);
        console.log(`  v1beta:    ${v1beta.substring(0, 60)}`);
        console.log(`  v1/messages: ${v1msg.substring(0, 60)}`);
      }
    }
  }
  
  db.close();
}

main().catch(console.error);
