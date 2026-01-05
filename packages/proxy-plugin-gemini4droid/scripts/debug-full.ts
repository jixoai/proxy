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
  
  // 检查数据库结构
  console.log("=== Database Schema ===");
  const schema = db.query<any, []>(`PRAGMA table_info(proxy_requests)`).all();
  console.log("Columns:", schema.map((c: any) => c.name).join(", "));

  // 检查是否有 upstream 相关的字段
  console.log("\n=== Sample Data Structure ===");
  const sample = db.query<any, []>(`SELECT data FROM proxy_requests LIMIT 1`).all();
  if (sample[0]) {
    const data = JSON.parse(sample[0].data);
    console.log("Data keys:", Object.keys(data));
    if (data.upstream) {
      console.log("Upstream keys:", Object.keys(data.upstream));
    }
  }

  // 对比 429 和 200 请求的完整数据
  console.log("\n=== 429 Request Full Data ===");
  const error429 = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code = 429
    ORDER BY id DESC LIMIT 1
  `).all();

  if (error429[0]) {
    const data = JSON.parse(error429[0].data);
    console.log("Data structure:", JSON.stringify(data, (key, val) => {
      if (key === 'bodyDataUrl' && typeof val === 'string') {
        return val.substring(0, 50) + '...';
      }
      return val;
    }, 2).substring(0, 3000));
  }

  console.log("\n=== 200 v1/messages Full Data ===");
  const success = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all();

  if (success[0]) {
    const data = JSON.parse(success[0].data);
    console.log("Data structure:", JSON.stringify(data, (key, val) => {
      if (key === 'bodyDataUrl' && typeof val === 'string') {
        return val.substring(0, 50) + '...';
      }
      return val;
    }, 2).substring(0, 3000));
  }

  db.close();
}

main().catch(console.error);
