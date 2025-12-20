/**
 * 插件服务器
 *
 * 负责启动 HTTP 服务器并处理 hook 请求
 */

import { encodeEnvelope, decodeEnvelope } from "./envelope";
import { isRecord, normalizeHeaders } from "./utils";
import type { ProxyPlugin, RequestMeta, ResponseMeta, PluginConfig } from "./types";

export interface PluginServerOptions extends PluginConfig {
  plugin: ProxyPlugin;
}

/**
 * 启动插件服务器
 */
export async function startPluginServer(options: PluginServerOptions): Promise<void> {
  const { plugin, debug } = options;

  const callbackUrl = process.env.__CALLBACK_URL__;
  if (!callbackUrl) {
    console.error(`[${plugin.name}] Missing __CALLBACK_URL__ env`);
    process.exit(1);
  }

  const log = debug ? console.log.bind(console) : () => {};

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

        if (url.pathname === "/hook-req-requestBody") {
          const normalizedMeta: RequestMeta = isRecord(meta) ? (meta as RequestMeta) : {};
          log(`[${plugin.name}] Request hook: ${normalizedMeta.method} ${normalizedMeta.url}`);

          if (plugin.onRequest) {
            const result = await plugin.onRequest({ meta: normalizedMeta, body });
            if (result) {
              // 检查是否是 respondWith - 短路请求，直接返回响应
              if ("respondWith" in result) {
                const { statusCode, body: respBody, headers: respHeaders } = result.respondWith;
                const payload = encodeEnvelope(
                  {
                    respondWith: true,
                    statusCode,
                    headers: respHeaders,
                  },
                  respBody ? Buffer.from(respBody) : Buffer.alloc(0)
                );
                return new Response(new Uint8Array(payload), {
                  status: 200,
                  headers: { "content-type": "application/octet-stream" },
                });
              }
              // 检查是否是 { modified: false }
              if ("modified" in result && result.modified === false) {
                const payload = encodeEnvelope({ modified: false }, body);
                return new Response(new Uint8Array(payload), {
                  status: 200,
                  headers: { "content-type": "application/octet-stream" },
                });
              }
              // 有修改
              const nextMeta = { ...normalizedMeta, ...result.meta };
              const nextBody = result.body ?? body;
              const payload = encodeEnvelope(
                {
                  modified: true,
                  method: nextMeta.method,
                  url: nextMeta.url,
                  headers: nextMeta.headers,
                },
                nextBody
              );
              return new Response(new Uint8Array(payload), {
                status: 200,
                headers: { "content-type": "application/octet-stream" },
              });
            }
          }

          // Pass-through (null/undefined) - 不记录该层
          const payload = encodeEnvelope(
            {
              skipped: true,
              method: normalizedMeta.method,
              url: normalizedMeta.url,
              headers: normalizedMeta.headers,
            },
            body
          );
          return new Response(new Uint8Array(payload), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        if (url.pathname === "/hook-res-requestBody") {
          const normalizedMeta: ResponseMeta = isRecord(meta) ? (meta as ResponseMeta) : {};
          log(`[${plugin.name}] Response hook: ${normalizedMeta.statusCode}`);

          if (plugin.onResponse) {
            const result = await plugin.onResponse({ meta: normalizedMeta, body });
            if (result) {
              // 检查是否是 { modified: false }
              if ("modified" in result && result.modified === false) {
                const payload = encodeEnvelope({ modified: false }, body);
                return new Response(new Uint8Array(payload), {
                  status: 200,
                  headers: { "content-type": "application/octet-stream" },
                });
              }
              // 有修改
              const nextMeta = { ...normalizedMeta, ...result.meta };
              const nextBody = result.body ?? body;
              const payload = encodeEnvelope(
                {
                  modified: true,
                  statusCode: nextMeta.statusCode,
                  statusMessage: nextMeta.statusMessage,
                  headers: nextMeta.headers,
                },
                nextBody
              );
              return new Response(new Uint8Array(payload), {
                status: 200,
                headers: { "content-type": "application/octet-stream" },
              });
            }
          }

          // Pass-through (null/undefined) - 不记录该层
          const payload = encodeEnvelope(
            {
              skipped: true,
              statusCode: normalizedMeta.statusCode,
              statusMessage: normalizedMeta.statusMessage,
              headers: normalizedMeta.headers,
            },
            body
          );
          return new Response(new Uint8Array(payload), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error(`[${plugin.name}] Handler error:`, err);
        return new Response("Internal Error", { status: 500 });
      }
    },
  });

  const listenUrl = `http://127.0.0.1:${server.port}/`;
  await fetch(callbackUrl, { method: "POST", body: listenUrl });
  console.log(`[${plugin.name}] Listening on ${listenUrl}`);

  const stop = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * 定义并启动插件（简化 API）
 */
export function definePlugin(plugin: ProxyPlugin, config?: PluginConfig): void {
  startPluginServer({ plugin, ...config }).catch((err) => {
    console.error(`[${plugin.name}] Fatal error:`, err);
    process.exit(1);
  });
}
