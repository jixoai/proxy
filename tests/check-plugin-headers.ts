import { Database } from "bun:sqlite";

const dbPath = "/Users/kzf/.jixo-proxy/proxy.db";
const db = new Database(dbPath, { readonly: true });

// 获取最近 5 条请求，查看完整信息
const rows = db.query("SELECT id, instance_name, forward_name, data FROM proxy_requests ORDER BY id DESC LIMIT 5").all() as { id: number; instance_name: string; forward_name: string; data: string }[];

for (const row of rows) {
  const data = JSON.parse(row.data);
  console.log("\n=== Request #" + row.id + " ===");
  console.log("Instance:", row.instance_name);
  console.log("Forward:", row.forward_name);
  console.log("hasHookedRequest:", !!data.hookedRequest);
  
  if (data.hookedRequest) {
    console.log("hookedRequest.url:", data.hookedRequest.url);
    console.log("hookedRequest.headers keys:", Object.keys(data.hookedRequest.headers || {}).slice(0, 10));
  }
}

db.close();
