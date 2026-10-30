import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { RouteStore } from "portless";
import { setConfigFilePath } from "../src/lib/config-store";
import { PortlessInstanceRoutes } from "../src/lib/portless";
import { getDataDir, setDataDir } from "../src/lib/runtime-paths";
import { ProxyInstancesManager, type InstanceStatusEvent } from "../src/proxy-instances-manager";

const directory = mkdtempSync(path.join(import.meta.dirname, ".worker-recovery-"));
const originalDataDir = getDataDir();
const manager = new ProxyInstancesManager();
const store = new RouteStore(path.join(directory, "portless"));
const routes = new PortlessInstanceRoutes("https://proxy.localhost", store);
const statuses: boolean[] = [];
const upstreamRequests: string[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let edge: ReturnType<typeof Bun.spawn>;
let edgePort: number;
let instancePort: number;

async function waitFor(predicate: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker recovery");
    await Bun.sleep(20);
  }
}

async function request(pathname: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${edgePort}${pathname}`,
      {
        method: "POST",
        headers: { host: "recovery.proxy.localhost", "content-type": "application/json" },
        signal: AbortSignal.timeout(10000),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

beforeAll(async () => {
  setDataDir(path.join(directory, "data"));
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const pathname = new URL(req.url).pathname;
      upstreamRequests.push(pathname);
      if (pathname === "/slow" || pathname === "/timeout") await Bun.sleep(2000);
      return Response.json({ ok: true, pathname });
    },
  });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  instancePort = reservation.port!;
  await reservation.stop(true);
  const configPath = path.join(directory, "proxy-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      instances: [
        {
          name: "recovery",
          port: instancePort,
          enabled: true,
          forwards: [{ name: "local", target: upstream.url.origin, enabled: true, timeout: 1 }],
        },
      ],
    }),
  );
  setConfigFilePath(configPath);
  manager.on("instance-state-changed", ({ instanceName, status }: InstanceStatusEvent) => {
    statuses.push(status.running);
    routes.update(instanceName, status);
  });
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is required to test the real Portless transport");
  edge = Bun.spawn(
    [
      node,
      "--input-type=module",
      "-e",
      `
    import { createProxyServer, RouteStore } from "portless";
    const store = new RouteStore(${JSON.stringify(path.join(directory, "portless"))});
    const server = createProxyServer({ getRoutes: () => store.loadRoutes(), proxyPort: 0 });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  if (typeof edge.stdout === "number" || !edge.stdout) {
    throw new Error("Expected piped Portless stdout");
  }
  const reader = edge.stdout.getReader();
  const portLine = await reader.read();
  reader.releaseLock();
  edgePort = Number(new TextDecoder().decode(portLine.value).trim());
  expect(edgePort).toBeGreaterThan(0);
  await manager.startInstance("recovery");
  expect((await manager.getInstanceWorkerConfig("recovery"))?.forwards[0]?.timeout).toBe(1);
  expect(await manager.checkInstanceConfigSync("recovery")).toBe(true);
}, 15000);

afterAll(async () => {
  await manager.stopAll();
  routes.close();
  if (edge) {
    edge.kill();
    await edge.exited;
  }
  if (upstream) await upstream.stop(true);
  setDataDir(originalDataDir);
  setConfigFilePath(path.resolve("proxy-config.json"));
  rmSync(directory, { recursive: true, force: true });
});

test("real Node Portless recovers routes after a worker crash without replaying an in-flight POST", async () => {
  const initial = await request("/before");
  expect(initial.status).toBe(200);
  const pending = request("/slow");
  await waitFor(() => upstreamRequests.includes("/slow"));
  const proxy = manager["managers"].get("recovery")!;
  const originalWorker = proxy["worker"]!;
  originalWorker.terminate();
  await waitFor(() => statuses.includes(false));
  expect(store.loadRoutes()).toEqual([]);
  const failed = await pending;
  expect(failed.status).toBe(502);
  const unavailable = await request("/during");
  expect(unavailable.status).toBe(404);
  await waitFor(() => statuses.length >= 3 && statuses.at(-1) === true);
  const restored = await request("/after");
  expect(restored.status).toBe(200);
  expect(JSON.parse(restored.body)).toEqual({ ok: true, pathname: "/after" });
  expect(upstreamRequests.filter((pathname) => pathname === "/slow")).toHaveLength(1);
  expect(statuses).toEqual([true, false, true]);
  expect(store.loadRoutes()[0]?.port).toBe(instancePort);
  expect((await manager.getInstanceWorkerConfig("recovery"))?.forwards[0]?.timeout).toBe(1);
  expect(await manager.checkInstanceConfigSync("recovery")).toBe(true);
  const timedOut = await request("/timeout");
  expect(timedOut.status).toBe(504);
  expect((await request("/after-timeout")).status).toBe(200);
  originalWorker.dispatchEvent(new Event("close"));
  expect(proxy.getStatus().running).toBe(true);
  await manager.stopInstance("recovery");
  expect(store.loadRoutes()).toEqual([]);
  expect(proxy["restartTimer"]).toBeNull();
}, 20000);

test("manual start replaces a failed manager and cancels its queued automatic restart", async () => {
  statuses.length = 0;
  await manager.startInstance("recovery");
  const previous = manager["managers"].get("recovery")!;
  previous["worker"]!.terminate();
  await waitFor(() => !previous.getStatus().running);
  expect(previous["restartTimer"]).not.toBeNull();
  await manager.startInstance("recovery");
  expect(manager["managers"].get("recovery")).not.toBe(previous);
  expect(previous["restartTimer"]).toBeNull();
  expect(previous["desiredRunning"]).toBe(false);
  expect((await request("/manual-restart")).status).toBe(200);
  expect(statuses).toEqual([true, false, true]);
  await manager.stopInstance("recovery");
  expect(store.loadRoutes()).toEqual([]);
}, 15000);
