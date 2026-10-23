import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { RouteStore, resolveUserHome, parseHostname } from "portless";

/** 低于该值端口需要 root 才能监听，代理须经 sudo 启动 */
const PRIVILEGED_PORT_MAX = 1023;
const DEFAULT_PROXY_PORT = 443;

function resolveProxyPort(): number {
  const raw = process.env.PORTLESS_PORT;
  if (!raw) return DEFAULT_PROXY_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORTLESS_PORT must be an integer between 1 and 65535, got "${raw}".`);
  }
  return port;
}

function isPortListening(port: number, host = "127.0.0.1", timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function waitForPortListening(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** pid 存活检查；对 root 进程 kill(0) 会 EPERM，同样代表存活 */
function isPidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPidFile(pidPath: string): number | null {
  try {
    return Number(fs.readFileSync(pidPath, "utf-8").trim()) || null;
  } catch {
    return null;
  }
}

/** routes.json 中是否还有存活进程注册的路由（说明别的 portless 会话仍在运行） */
function findLiveSessionPids(routesPath: string): number[] {
  try {
    const routes = JSON.parse(fs.readFileSync(routesPath, "utf-8")) as Array<{
      hostname: string;
      pid?: number;
    }>;
    return routes
      .map((route) => route.pid ?? 0)
      .filter((pid) => isPidAlive(pid));
  } catch {
    return [];
  }
}

/** 调用 `portless proxy stop`（对 root 守护进程会在终端内自动 sudo 提权） */
function stopPortlessProxy(
  node: string,
  cliPath: string,
  stateDir: string,
  proxyPort: number,
): boolean {
  const result = spawnSync(node, [cliPath, "proxy", "stop", "-p", String(proxyPort)], {
    stdio: "inherit",
    timeout: 120_000,
    env: { ...process.env, PORTLESS_STATE_DIR: stateDir },
  });
  return result.status === 0 && !result.signal;
}

export async function runWithPortless(name: string, port?: number, lan = false): Promise<number> {
  parseHostname(name);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Portless --port must be an integer between 1 and 65535.");
  }
  const node = Bun.which("node");
  if (!node) {
    throw new Error("Portless requires Node.js 24 or newer. Install Node.js and retry.");
  }
  const majorVersion = Number(
    execFileSync(node, ["-p", "process.versions.node.split('.')[0]"], {
      encoding: "utf8",
    }).trim(),
  );
  if (majorVersion < 24) {
    throw new Error("Portless requires Node.js 24 or newer. Upgrade Node.js and retry.");
  }

  const cliPath = path.join(
    path.dirname(Bun.resolveSync("portless", import.meta.dirname)),
    "cli.js",
  );
  const stateDir = process.env.PORTLESS_STATE_DIR || path.join(resolveUserHome(), ".portless");
  const proxyPort = resolveProxyPort();
  const pidPath = path.join(stateDir, "proxy.pid");
  const routesPath = path.join(stateDir, "routes.json");

  // 代理以会话子进程方式独占运行，因此启动前不能有其他存活会话
  const livePids = findLiveSessionPids(routesPath);
  if (livePids.length > 0) {
    throw new Error(
      `Another portless session is still running (pids: ${livePids.join(", ")}). ` +
        "Stop it with Ctrl+C before starting a new one.",
    );
  }

  // 停掉残留的 portless 代理（例如上次异常退出留下的 root 守护进程），
  // 保证代理生命周期始终跟随本次 bun 会话，Ctrl+C 后不再有进程残留。
  if (await isPortListening(proxyPort)) {
    const daemonPid = readPidFile(pidPath);
    if (!isPidAlive(daemonPid)) {
      throw new Error(
        `Port ${proxyPort} is occupied by a non-portless process. ` +
          "Free the port or set PORTLESS_PORT to another value.",
      );
    }
    console.log(`[Portless] Stopping leftover proxy on port ${proxyPort} (may ask for sudo)...`);
    if (!stopPortlessProxy(node, cliPath, stateDir, proxyPort)) {
      throw new Error(
        `Failed to stop the leftover portless proxy on port ${proxyPort}. ` +
          `Try manually: sudo portless proxy stop -p ${proxyPort}`,
      );
    }
    if (await isPortListening(proxyPort)) {
      throw new Error(`Port ${proxyPort} is still in use after stopping the portless proxy.`);
    }
  }

  // 以前台子进程启动代理：特权端口经 sudo（启动时可能需要输入一次密码）。
  // Ctrl+C 时终端向前台进程组广播 SIGINT，代理会自行清理（hosts/pid/mDNS）后退出，
  // 不再留下跨会话常驻的守护进程。
  const needsSudo = process.platform !== "win32" && proxyPort <= PRIVILEGED_PORT_MAX;
  const proxyArgs = [
    cliPath,
    "proxy",
    "start",
    "--foreground",
    "--port",
    String(proxyPort),
    "--https",
    ...(lan ? ["--lan"] : []),
    "--skip-trust",
  ];
  const proxyChild = needsSudo
    ? spawn(
        "sudo",
        ["env", `HOME=${resolveUserHome()}`, `PORTLESS_STATE_DIR=${stateDir}`, node, ...proxyArgs],
        { stdio: "inherit" },
      )
    : spawn(node, proxyArgs, {
        stdio: "inherit",
        env: { ...process.env, PORTLESS_STATE_DIR: stateDir },
      });

  let proxyStartError: string | undefined;
  proxyChild.once("error", (error) => {
    proxyStartError = String(error);
  });
  proxyChild.once("exit", (code) => {
    if (proxyStartError === undefined && code !== null && ![0, 130, 143].includes(code)) {
      proxyStartError = `portless proxy exited with code ${code}`;
    }
  });

  const proxyReady = await waitForPortListening(proxyPort, 20_000);
  if (!proxyReady) {
    if (!needsSudo && proxyChild.exitCode === null) proxyChild.kill("SIGKILL");
    throw new Error(proxyStartError ?? `Portless proxy did not become ready on port ${proxyPort}.`);
  }

  // 会话结束（Ctrl+C / app 退出）后的兜底：正常情况下代理已随前台进程组收到 SIGINT 自行退出
  const stopOwnedProxy = async (reason: string) => {
    if (proxyChild.exitCode !== null) return;
    if (!needsSudo) proxyChild.kill("SIGTERM");
    const deadline = Date.now() + 1_500;
    while (proxyChild.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (proxyChild.exitCode !== null) return;
    console.log(`[Portless] ${reason}: stopping proxy (may ask for sudo)...`);
    stopPortlessProxy(node, cliPath, stateDir, proxyPort);
  };

  const child = spawn(
    node,
    [
      cliPath,
      ...(lan ? ["--lan"] : []),
      "--name",
      name,
      ...(port === undefined ? [] : ["--app-port", String(port)]),
      "--",
      process.execPath,
      ...process.execArgv,
      process.argv[1]!,
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PORTLESS: "1",
        PORTLESS_HTTPS: "1",
        PORTLESS_PORT: String(proxyPort),
        PORTLESS_STATE_DIR: stateDir,
        JIXO_PORTLESS_CHILD: "1",
        ...(lan ? { JIXO_PORTLESS_LAN: "1" } : {}),
      },
    },
  );

  const onInterrupt = () => child.kill("SIGINT");
  const onTerminate = () => child.kill("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    await stopOwnedProxy("Session ended");
  }
}

export function getInstanceHostname(instanceName: string, viewerHostname: string): string {
  const normalized = instanceName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = createHash("sha256").update(instanceName).digest("hex").slice(0, 8);
  const label =
    normalized === instanceName && normalized.length <= 63
      ? normalized
      : `${normalized.slice(0, 54) || "instance"}-${suffix}`;
  const tld = viewerHostname.split(".").at(-1) || "localhost";
  return parseHostname(`${label}.${viewerHostname}`, tld);
}

export class PortlessInstanceRoutes {
  private readonly routes = new Map<string, string>();
  private readonly viewerUrl: URL;

  constructor(
    publicUrl: string,
    private readonly store = new RouteStore(
      process.env.PORTLESS_STATE_DIR || path.join(resolveUserHome(), ".portless"),
    ),
    private readonly ownerPid = process.pid,
  ) {
    this.viewerUrl = new URL(publicUrl);
  }

  update(instanceName: string, status: { running: boolean; port: number }): string | undefined {
    if (!status.running) {
      this.remove(instanceName);
      return;
    }
    const hostname = getInstanceHostname(instanceName, this.viewerUrl.hostname);
    this.store.addRoute(hostname, status.port, this.ownerPid);
    this.routes.set(instanceName, hostname);
    const url = new URL(this.viewerUrl);
    url.hostname = hostname;
    return url.origin;
  }

  private remove(instanceName: string): void {
    const hostname = this.routes.get(instanceName);
    if (!hostname) return;
    this.store.removeRoute(hostname, this.ownerPid);
    this.routes.delete(instanceName);
  }

  close(): void {
    for (const instanceName of this.routes.keys()) {
      this.remove(instanceName);
    }
  }
}
