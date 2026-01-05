#!/usr/bin/env bun
/**
 * 分析 proxy.db 中的 Gemini 请求
 */

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

interface RequestData {
  request?: {
    bodyDataUrl?: string;
    headers?: Record<string, string>;
  };
  response?: {
    bodyDataUrl?: string;
    statusCode?: number;
  };
}

function decodeDataUrl(dataUrl: string): string | null {
  if (!dataUrl) return null;
  
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  
  try {
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");
    
    // 尝试直接解码
    try {
      return buffer.toString("utf-8");
    } catch {
      // 尝试 gzip 解压
      try {
        const decompressed = gunzipSync(buffer);
        return decompressed.toString("utf-8");
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  
  // 获取成功的 Gemini 请求
  const rows = db.query<ProxyRequest, []>(`
    SELECT id, request_url, status_code, data 
    FROM proxy_requests 
    WHERE request_url LIKE '%/gemini/%' 
      AND status_code = 200
    ORDER BY id DESC 
    LIMIT 20
  `).all();
  
  console.log(`Found ${rows.length} successful Gemini requests\n`);
  
  // 分析每个请求
  const toolsUsed = new Set<string>();
  const partsTypes = new Set<string>();
  const generationConfigs: any[] = [];
  
  for (const row of rows) {
    const data: RequestData = JSON.parse(row.data);
    
    // 解码请求体
    if (data.request?.bodyDataUrl) {
      const bodyText = decodeDataUrl(data.request.bodyDataUrl);
      if (bodyText) {
        try {
          const body = JSON.parse(bodyText);
          
          // 收集 tools
          if (body.tools?.[0]?.functionDeclarations) {
            for (const func of body.tools[0].functionDeclarations) {
              toolsUsed.add(func.name);
            }
          }
          
          // 收集 parts 类型
          if (body.contents) {
            for (const content of body.contents) {
              if (content.parts) {
                for (const part of content.parts) {
                  const keys = Object.keys(part);
                  partsTypes.add(keys.join("+"));
                }
              }
            }
          }
          
          // 收集 generationConfig
          if (body.generationConfig) {
            generationConfigs.push(body.generationConfig);
          }
        } catch (e) {
          console.log(`Request ${row.id}: Failed to parse body`);
        }
      }
    }
    
    // 解码响应体 (SSE)
    if (data.response?.bodyDataUrl) {
      const responseText = decodeDataUrl(data.response.bodyDataUrl);
      if (responseText) {
        // 分析 SSE 响应中的 parts 类型
        const lines = responseText.split("\n").filter(l => l.startsWith("data:"));
        for (const line of lines.slice(0, 5)) {
          try {
            const chunk = JSON.parse(line.slice(5).trim());
            if (chunk.candidates?.[0]?.content?.parts) {
              for (const part of chunk.candidates[0].content.parts) {
                const keys = Object.keys(part);
                partsTypes.add("response:" + keys.join("+"));
              }
            }
          } catch {}
        }
      }
    }
  }
  
  console.log("=== Tools Used ===");
  console.log([...toolsUsed].sort().join("\n"));
  
  console.log("\n=== Parts Types ===");
  console.log([...partsTypes].sort().join("\n"));
  
  console.log("\n=== Generation Config Sample ===");
  if (generationConfigs[0]) {
    console.log(JSON.stringify(generationConfigs[0], null, 2));
  }
  
  // 找一个包含 functionCall 的响应示例
  console.log("\n=== Looking for functionCall example ===");
  for (const row of rows) {
    const data: RequestData = JSON.parse(row.data);
    if (data.response?.bodyDataUrl) {
      const responseText = decodeDataUrl(data.response.bodyDataUrl);
      if (responseText?.includes("functionCall")) {
        console.log(`Found in request ${row.id}`);
        const lines = responseText.split("\n").filter(l => l.includes("functionCall"));
        if (lines[0]) {
          try {
            const chunk = JSON.parse(lines[0].slice(5).trim());
            console.log(JSON.stringify(chunk, null, 2));
          } catch {}
        }
        break;
      }
    }
  }
  
  // 找一个包含 functionResponse 的请求示例
  console.log("\n=== Looking for functionResponse example ===");
  for (const row of rows) {
    const data: RequestData = JSON.parse(row.data);
    if (data.request?.bodyDataUrl) {
      const bodyText = decodeDataUrl(data.request.bodyDataUrl);
      if (bodyText?.includes("functionResponse")) {
        console.log(`Found in request ${row.id}`);
        try {
          const body = JSON.parse(bodyText);
          // 找包含 functionResponse 的 content
          for (const content of body.contents || []) {
            for (const part of content.parts || []) {
              if (part.functionResponse) {
                console.log("Sample functionResponse part:");
                console.log(JSON.stringify(part, null, 2).slice(0, 2000));
                break;
              }
            }
          }
        } catch {}
        break;
      }
    }
  }
  
  db.close();
}

main().catch(console.error);
