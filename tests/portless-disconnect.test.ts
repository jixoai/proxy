import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";

for (const secure of [false, true]) {
  test(`real Node Portless ${secure ? "HTTPS/2" : "HTTP/1.1"} distinguishes client cancellation from backend reset`, async () => {
    const node = Bun.which("node");
    if (!node) throw new Error("Node.js is required for the Portless transport test");
    const directory = secure ? mkdtempSync(path.join(import.meta.dirname, ".portless-tls-")) : null;
    const child = Bun.spawn(
      [
        node,
        "--input-type=module",
        "-e",
        `
    import http from "node:http";
    import http2 from "node:http2";
    import { execFileSync } from "node:child_process";
    import { readFileSync } from "node:fs";
    import path from "node:path";
    import { createProxyServer } from "portless";
    const secure = ${secure};
    const directory = ${JSON.stringify(directory)};
    let tls;
    if (secure) {
      const keyPath = path.join(directory, "key.pem");
      const certPath = path.join(directory, "cert.pem");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
        "-out", certPath, "-subj", "/CN=disconnect.localhost", "-addext",
        "subjectAltName=DNS:disconnect.localhost", "-days", "1"], { stdio: "ignore" });
      tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    }
    const errors = [];
    let requests = 0;
    let pendingResponse;
    const upstream = http.createServer((req, res) => {
      requests++;
      if (req.url === "/wait") { pendingResponse = res; return; }
      if (req.url === "/reset") { req.socket.destroy(); return; }
      res.end("ok");
    });
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = upstream.address().port;
    const edge = createProxyServer({
      getRoutes: () => [{ hostname: "disconnect.localhost", port: upstreamPort, pid: process.pid }],
      proxyPort: 0, onError: message => errors.push(message), tls
    });
    await new Promise(resolve => edge.listen(0, "127.0.0.1", resolve));
    const session = secure ? http2.connect("https://127.0.0.1:" + edge.address().port,
      { ca: tls.cert, servername: "disconnect.localhost" }) : null;
    const openRequest = (pathname, onResponse) => {
      if (session) {
        const req = session.request({ ":method": "GET", ":path": pathname, ":authority": "disconnect.localhost" });
        req.on("response", headers => onResponse?.(headers[":status"], req));
        return req;
      }
      return http.get({ hostname: "127.0.0.1", port: edge.address().port, path: pathname,
        headers: { host: "disconnect.localhost" } }, res => onResponse?.(res.statusCode, res));
    };
    const request = pathname => new Promise((resolve, reject) => {
      const req = openRequest(pathname, (status, res) => {
        res.resume(); res.on("end", () => resolve(status)); res.on("error", reject);
      });
      req.on("error", reject);
    });
    try {
      const canceled = openRequest("/wait");
      canceled.on("error", () => {});
      const deadline = Date.now() + 2000;
      while (!pendingResponse) {
        if (Date.now() > deadline) throw new Error("request did not reach upstream");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (session) canceled.close(http2.constants.NGHTTP2_CANCEL);
      else canceled.destroy();
      await new Promise(resolve => setTimeout(resolve, 100));
      const cancellationErrors = errors.splice(0);
      pendingResponse.end("late");
      const resetStatus = await request("/reset");
      const resetErrors = errors.splice(0);
      const recoveredStatus = await request("/ok");
      await new Promise(resolve => upstream.close(resolve));
      const refusedStatus = await request("/refused");
      const refusedErrors = errors.splice(0);
      console.log(JSON.stringify({ cancellationErrors, resetStatus, resetErrors, recoveredStatus, refusedStatus, refusedErrors, requests }));
    } finally {
      session?.destroy();
      edge.closeAllConnections?.(); edge.close(); upstream.closeAllConnections(); upstream.close();
    }
  `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const killTimer = setTimeout(() => child.kill(), 8000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.cancellationErrors).toEqual([]);
      expect(result.resetStatus).toBe(502);
      expect(result.resetErrors).toHaveLength(1);
      expect(result.resetErrors[0]).toContain("ECONNRESET");
      expect(result.resetErrors[0]).toContain("backend=127.0.0.1:");
      expect(result.recoveredStatus).toBe(200);
      expect(result.refusedStatus).toBe(502);
      expect(result.refusedErrors).toHaveLength(1);
      expect(result.refusedErrors[0]).toContain("ECONNREFUSED");
      expect(result.requests).toBe(3);
    } finally {
      clearTimeout(killTimer);
      child.kill();
      await child.exited;
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
}
