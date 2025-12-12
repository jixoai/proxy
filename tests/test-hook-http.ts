#!/usr/bin/env bun
/**
 * 简单的测试 hook，验证 HTTP 协议是否正常工作
 */

const HEAD_LEN_BYTES = 4;

function encodeEnvelope(meta: unknown, body: Uint8Array): Buffer {
  const metaBuffer = Buffer.from(JSON.stringify(meta ?? {}), "utf-8");
  const lenBuffer = Buffer.alloc(HEAD_LEN_BYTES);
  lenBuffer.writeUInt32BE(metaBuffer.length, 0);
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([lenBuffer, metaBuffer, bodyBuffer]);
}

function decodeEnvelope(buffer: Buffer): { meta: unknown; body: Buffer } {
  if (buffer.length < HEAD_LEN_BYTES) {
    throw new Error("invalid envelope: missing head-len");
  }
  const headLen = buffer.readUInt32BE(0);
  if (buffer.length < HEAD_LEN_BYTES + headLen) {
    throw new Error("invalid envelope: head-len mismatch");
  }
  const metaBuffer = buffer.subarray(HEAD_LEN_BYTES, HEAD_LEN_BYTES + headLen);
  const body = buffer.subarray(HEAD_LEN_BYTES + headLen);
  const metaJson = metaBuffer.toString("utf-8") || "{}";
  return { meta: JSON.parse(metaJson), body };
}

async function start() {
  const callbackUrl = process.env.__CALLBACK_URL__;
  if (!callbackUrl) {
    console.error("[test-hook] Missing __CALLBACK_URL__ env");
    process.exit(1);
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const url = new URL(req.url);
      const raw = Buffer.from(await req.arrayBuffer());

      try {
        const { meta, body } = decodeEnvelope(raw);
        console.error(`[test-hook] ${url.pathname}`, { meta, bodyLen: body.length });

        if (url.pathname === "/hook-req-requestBody") {
          // 简单透传，不做任何修改
          const payload = encodeEnvelope(meta, body);
          return new Response(new Uint8Array(payload), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        if (url.pathname === "/hook-res-requestBody") {
          // 简单透传
          const payload = encodeEnvelope(meta, body);
          return new Response(new Uint8Array(payload), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error("[test-hook] Handler error", err);
        return new Response("Internal Error", { status: 500 });
      }
    },
  });

  const listenUrl = `http://127.0.0.1:${server.port}/`;
  await fetch(callbackUrl, { method: "POST", body: listenUrl });
  console.error(`[test-hook] Listening on ${listenUrl}`);

  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error("[test-hook] Fatal error:", err);
  process.exit(1);
});
