import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { RouteStore, resolveUserHome, parseHostname } from "portless";

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
        PORTLESS_STATE_DIR:
          process.env.PORTLESS_STATE_DIR || path.join(resolveUserHome(), ".portless"),
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
