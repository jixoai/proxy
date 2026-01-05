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
  
  // 检查 429 请求的 body 格式
  console.log("=== 429 Request Body Analysis ===");
  const error429 = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code = 429
    ORDER BY id DESC LIMIT 1
  `).all();

  if (error429[0]) {
    const data = JSON.parse(error429[0].data);
    if (data.request?.bodyDataUrl) {
      const body = decodeDataUrl(data.request.bodyDataUrl);
      if (body) {
        try {
          const parsed = JSON.parse(body);
          console.log("Body Format (Keys):", Object.keys(parsed));
          console.log("Has 'messages'?", !!parsed.messages);  // Anthropic 格式
          console.log("Has 'contents'?", !!parsed.contents);  // Gemini 格式
          console.log("Has 'system'?", !!parsed.system);
          console.log("Model:", parsed.model);
          console.log("Stream:", parsed.stream);
          
          // 检查是否是 Droid 请求
          if (parsed.system) {
            const systemText = typeof parsed.system === 'string' 
              ? parsed.system 
              : parsed.system.map((s: any) => s.text).join('');
            console.log("\nSystem contains 'Droid'?", systemText.includes('Droid'));
            console.log("System contains 'Factory'?", systemText.includes('Factory'));
            console.log("System preview:", systemText.substring(0, 200));
          }
        } catch (e) {
          console.log("Parse error:", e);
        }
      }
    }
  }

  // 检查成功的 v1/messages 请求的 body
  console.log("\n=== Successful v1/messages Body ===");
  const success = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1/messages%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all();

  if (success[0]) {
    const data = JSON.parse(success[0].data);
    if (data.request?.bodyDataUrl) {
      const body = decodeDataUrl(data.request.bodyDataUrl);
      if (body) {
        try {
          const parsed = JSON.parse(body);
          console.log("Body Format (Keys):", Object.keys(parsed));
          console.log("Has 'messages'?", !!parsed.messages);
          console.log("Has 'contents'?", !!parsed.contents);
          console.log("Model:", parsed.model);
        } catch {}
      }
    }
  }

  // 检查成功的 v1beta 请求的 body  
  console.log("\n=== v1beta Request Body ===");
  const v1beta = db.query<any, []>(`
    SELECT id, data FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/v1beta/models/%:streamGenerateContent%' AND status_code = 200
    ORDER BY id DESC LIMIT 1
  `).all();

  if (v1beta[0]) {
    const data = JSON.parse(v1beta[0].data);
    if (data.request?.bodyDataUrl) {
      const body = decodeDataUrl(data.request.bodyDataUrl);
      if (body) {
        try {
          const parsed = JSON.parse(body);
          console.log("Body Format (Keys):", Object.keys(parsed));
          console.log("Has 'messages'?", !!parsed.messages);
          console.log("Has 'contents'?", !!parsed.contents);
        } catch {}
      }
    }
  }

  db.close();
}

main().catch(console.error);
