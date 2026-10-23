/**
 * 复现/验证 Bun dev-server Host 白名单行为(HTML import 路由):
 *
 * - Bun 的 DNS-rebinding 防护只允许 Host 为 localhost / *.localhost / IP / 绑定 hostname,
 *   否则 HTML 路由返回 403 "Blocked: Host header does not match the dev server"。
 *   Portless 转发保留原始 Host(如 proxy.local),因此 Portless HTTPS 模式下必须把
 *   公网 hostname 传给 Bun.serve({ hostname }) 才能放行。
 *
 * 运行: bun tests/host-allow-check.test.ts
 * 注意: hostname 绑定验证需要 proxy.local 可解析(即 portless 会话存活),否则跳过该项。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const tmpDir = fs.mkdtempSync("/tmp/bun-host-check-");
const htmlPath = path.join(tmpDir, "index.html");
fs.writeFileSync(
  htmlPath,
  '<!doctype html><html><body>hi<script type="module" src="./app.ts"></script></body></html>',
);
fs.writeFileSync(path.join(tmpDir, "app.ts"), 'document.body.append("ok");');
const mod = await import(pathToFileURL(htmlPath).href);
const viewerHtml = (mod as { default: unknown }).default;

const PORT_DEFAULT = 39911;
const PORT_NAMED = 39912;

const s1 = Bun.serve({ port: PORT_DEFAULT, routes: { "/*": viewerHtml as any } });

function resolvesLocally(hostname: string): boolean {
  try {
    return require("node:dns").lookupSync(hostname) != null;
  } catch {
    return false;
  }
}

async function probe(port: number, hostHeader: string) {
  const proc = Bun.spawn([
    "curl",
    "-s",
    "--noproxy",
    "*",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-H",
    `Host: ${hostHeader}`,
    `http://127.0.0.1:${port}/`,
  ]);
  return await new Response(proc.stdout).text();
}

const results: Record<string, string> = {
  defaultHostnameWithProxyLocalHost: await probe(PORT_DEFAULT, "proxy.local"), // 期望 403
  defaultHostnameWithLocalhost: await probe(PORT_DEFAULT, "localhost"), // 期望 200
};

let s2: ReturnType<typeof Bun.serve> | undefined;
if (resolvesLocally("proxy.local")) {
  s2 = Bun.serve({
    port: PORT_NAMED,
    hostname: "proxy.local",
    routes: { "/*": viewerHtml as any },
  });
  results.namedHostnameWithProxyLocalHost = await probe(PORT_NAMED, "proxy.local"); // 期望 200
} else {
  results.namedHostnameWithProxyLocalHost = "skipped: proxy.local 未解析(无活动 portless 会话)";
}

s1.stop(true);
s2?.stop(true);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(results);
const ok =
  results.defaultHostnameWithProxyLocalHost === "403" &&
  results.defaultHostnameWithLocalhost === "200" &&
  (results.namedHostnameWithProxyLocalHost === "200" ||
    results.namedHostnameWithProxyLocalHost.startsWith("skipped"));
console.log(ok ? "PASS: host allowlist behaves as diagnosed" : "FAIL: behavior changed, re-check Bun version");
if (!ok) process.exit(1);
