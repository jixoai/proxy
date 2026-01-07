/**
 * HTTP 代理服务器
 *
 * 作为标准 HTTP 正向代理运行，调用 plugin hooks 处理请求/响应
 */

import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import type {
  ProxyPlugin,
  RequestMeta,
  ResponseMeta,
  PluginStore,
} from "@jixo/proxy-plugin";
import {
  createPluginStore,
  readStreamToBuffer,
  streamFromBuffer,
} from "@jixo/proxy-plugin";
import { reportReady } from "./callback";

export interface ProxyServerOptions {
  plugin: ProxyPlugin;
  port?: number;
}

function nodeReadableToWebStream(readable: http.IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      readable.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      readable.on("end", () => {
        controller.close();
      });
      readable.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel() {
      readable.destroy();
    },
  });
}

async function pipeWebStreamToNodeResponse(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function getProxyEnv(): { httpProxy?: string; httpsProxy?: string } {
  return {
    httpProxy: process.env.HTTP_PROXY || process.env.http_proxy,
    httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy,
  };
}

export function createProxyServer(options: ProxyServerOptions): void {
  const { plugin, port = 0 } = options;
  const pluginConfig = JSON.parse(process.env.PLUGIN_CONFIG || "{}");

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = req.url;
      if (!requestUrl || !requestUrl.startsWith("http")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid proxy request: absolute URI required" }));
        return;
      }

      const targetUrl = new URL(requestUrl);
      const method = req.method || "GET";
      const requestHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) {
          requestHeaders[key] = value as string | string[];
        }
      }

      const requestMeta: RequestMeta = {
        method,
        url: targetUrl.href,
        headers: requestHeaders,
      };

      const requestBodyStream = nodeReadableToWebStream(req);

      let finalMethod = method;
      let finalUrl = targetUrl;
      let finalHeaders = { ...requestHeaders };
      let finalBodyStream = requestBodyStream;

      // Request hook
      if (plugin.onRequest) {
        const shouldProcess = plugin.shouldProcessRequest
          ? await plugin.shouldProcessRequest(requestMeta)
          : true;

        if (shouldProcess === true) {
          const store = createPluginStore(
            plugin.name,
            (plugin as any).storeSchema,
            requestHeaders,
          );

          const hookResult = await plugin.onRequest({
            meta: requestMeta,
            body: requestBodyStream,
            store,
          });

          if (hookResult) {
            if ("respondWith" in hookResult) {
              const { statusCode, headers, body } = hookResult.respondWith;
              res.writeHead(statusCode, headers);
              if (body) {
                res.end(typeof body === "string" ? body : body);
              } else {
                res.end();
              }
              return;
            }

            if (!("modified" in hookResult) || hookResult.modified !== false) {
              if (hookResult.meta?.method) finalMethod = hookResult.meta.method;
              if (hookResult.meta?.url) finalUrl = new URL(hookResult.meta.url);
              if (hookResult.meta?.headers) {
                finalHeaders = hookResult.meta.headers as Record<string, string | string[]>;
              }
              if (hookResult.body) {
                finalBodyStream = hookResult.body;
              }
            }
          }
        }
      }

      // Forward request
      const proxyEnv = getProxyEnv();
      const isHttps = finalUrl.protocol === "https:";
      const upstreamProxy = isHttps ? proxyEnv.httpsProxy : proxyEnv.httpProxy;

      let proxyResponse: http.IncomingMessage;

      if (upstreamProxy) {
        // Use upstream proxy (next hop)
        proxyResponse = await forwardViaProxy(
          upstreamProxy,
          finalMethod,
          finalUrl,
          finalHeaders,
          finalBodyStream,
        );
      } else {
        // Direct connection
        proxyResponse = await forwardDirect(
          finalMethod,
          finalUrl,
          finalHeaders,
          finalBodyStream,
        );
      }

      const responseMeta: ResponseMeta = {
        statusCode: proxyResponse.statusCode,
        statusMessage: proxyResponse.statusMessage,
        headers: proxyResponse.headers as Record<string, string | string[]>,
      };

      let finalStatusCode = proxyResponse.statusCode || 502;
      let finalStatusMessage = proxyResponse.statusMessage || "";
      let finalResponseHeaders = { ...proxyResponse.headers };
      let finalResponseBodyStream = nodeReadableToWebStream(proxyResponse);

      // Response hook
      if (plugin.onResponse) {
        const shouldProcess = plugin.shouldProcessResponse
          ? await plugin.shouldProcessResponse(responseMeta, requestMeta)
          : true;

        if (shouldProcess === true) {
          const store = createPluginStore(
            plugin.name,
            (plugin as any).storeSchema,
            finalHeaders,
          );

          const hookResult = await plugin.onResponse({
            meta: responseMeta,
            body: finalResponseBodyStream,
            requestMeta,
            store,
          });

          if (hookResult && (!("modified" in hookResult) || hookResult.modified !== false)) {
            if (hookResult.meta?.statusCode) finalStatusCode = hookResult.meta.statusCode;
            if (hookResult.meta?.statusMessage) finalStatusMessage = hookResult.meta.statusMessage;
            if (hookResult.meta?.headers) {
              finalResponseHeaders = hookResult.meta.headers as http.IncomingHttpHeaders;
            }
            if (hookResult.body) {
              finalResponseBodyStream = hookResult.body;
            }
          }
        }
      }

      // Remove hop-by-hop headers
      const hopByHopHeaders = [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
      ];
      for (const h of hopByHopHeaders) {
        delete finalResponseHeaders[h];
      }

      res.writeHead(finalStatusCode, finalStatusMessage, finalResponseHeaders);
      await pipeWebStreamToNodeResponse(finalResponseBodyStream, res);
    } catch (error) {
      console.error(`[${plugin.name}] Proxy error:`, error);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Proxy error", message: String(error) }));
      }
    }
  });

  server.listen(port, "127.0.0.1", async () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    const url = `http://127.0.0.1:${actualPort}`;

    await reportReady(url);
  });

  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

async function forwardDirect(
  method: string,
  url: URL,
  headers: Record<string, string | string[]>,
  bodyStream: ReadableStream<Uint8Array>,
): Promise<http.IncomingMessage> {
  const isHttps = url.protocol === "https:";
  const requestModule = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;

  const outHeaders: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "host") {
      outHeaders[key] = value;
    }
  }
  outHeaders.host = url.host;

  const bodyBuffer = await readStreamToBuffer(bodyStream);

  return new Promise((resolve, reject) => {
    const req = requestModule.request(
      {
        hostname: url.hostname,
        port: url.port || defaultPort,
        path: url.pathname + url.search,
        method,
        headers: outHeaders,
      },
      (res) => {
        resolve(res);
      },
    );

    req.on("error", reject);

    if (bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

async function forwardViaProxy(
  proxyUrl: string,
  method: string,
  targetUrl: URL,
  headers: Record<string, string | string[]>,
  bodyStream: ReadableStream<Uint8Array>,
): Promise<http.IncomingMessage> {
  const proxy = new URL(proxyUrl);
  const isTargetHttps = targetUrl.protocol === "https:";

  const outHeaders: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    outHeaders[key] = value;
  }
  outHeaders.host = targetUrl.host;

  const bodyBuffer = await readStreamToBuffer(bodyStream);

  if (isTargetHttps) {
    // HTTPS via CONNECT tunnel
    return new Promise((resolve, reject) => {
      const proxyPort = proxy.port ? parseInt(proxy.port, 10) : 80;
      const connectReq = http.request({
        hostname: proxy.hostname,
        port: proxyPort,
        method: "CONNECT",
        path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      });

      connectReq.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`CONNECT failed: ${res.statusCode}`));
          return;
        }

        const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
        const tls = require("tls") as typeof import("tls");
        const tlsSocket = tls.connect(
          {
            host: targetUrl.hostname,
            port: targetPort,
            socket,
            servername: targetUrl.hostname,
          },
          () => {
            // Manually write HTTP request over TLS socket
            const requestLine = `${method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`;
            const headerLines: string[] = [];
            for (const [key, value] of Object.entries(outHeaders)) {
              if (Array.isArray(value)) {
                for (const v of value) {
                  headerLines.push(`${key}: ${v}`);
                }
              } else if (value !== undefined) {
                headerLines.push(`${key}: ${value}`);
              }
            }
            if (bodyBuffer.length > 0 && !outHeaders["content-length"]) {
              headerLines.push(`content-length: ${bodyBuffer.length}`);
            }
            const httpRequest = requestLine + headerLines.join("\r\n") + "\r\n\r\n";
            
            tlsSocket.write(httpRequest);
            if (bodyBuffer.length > 0) {
              tlsSocket.write(bodyBuffer);
            }

            // Parse HTTP response from TLS socket
            let responseData = Buffer.alloc(0);
            let headersParsed = false;
            let incomingMessage: http.IncomingMessage | null = null;

            tlsSocket.on("data", (chunk: Buffer) => {
              responseData = Buffer.concat([responseData, chunk]);
              
              if (!headersParsed) {
                const headerEnd = responseData.indexOf("\r\n\r\n");
                if (headerEnd !== -1) {
                  headersParsed = true;
                  const headerPart = responseData.subarray(0, headerEnd).toString();
                  const bodyPart = responseData.subarray(headerEnd + 4);
                  
                  const lines = headerPart.split("\r\n");
                  const statusLine = lines[0] || "";
                  const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+) (.*)/);
                  const statusCode = statusMatch ? parseInt(statusMatch[1]!, 10) : 502;
                  const statusMessage = statusMatch ? statusMatch[2]! : "";
                  
                  const responseHeaders: http.IncomingHttpHeaders = {};
                  for (let i = 1; i < lines.length; i++) {
                    const colonIdx = lines[i]!.indexOf(":");
                    if (colonIdx > 0) {
                      const key = lines[i]!.substring(0, colonIdx).toLowerCase();
                      const value = lines[i]!.substring(colonIdx + 1).trim();
                      responseHeaders[key] = value;
                    }
                  }

                  // Create a readable stream for the response
                  const { Readable } = require("stream") as typeof import("stream");
                  const bodyStream = new Readable({ read() {} });
                  
                  incomingMessage = Object.assign(bodyStream, {
                    statusCode,
                    statusMessage,
                    headers: responseHeaders,
                    headersDistinct: {},
                    httpVersion: "1.1",
                    httpVersionMajor: 1,
                    httpVersionMinor: 1,
                    complete: false,
                    rawHeaders: [],
                    trailers: {},
                    trailersDistinct: {},
                    rawTrailers: [],
                    socket: tlsSocket,
                    connection: tlsSocket,
                    aborted: false,
                    url: "",
                    method: null,
                    setTimeout: () => bodyStream,
                  }) as unknown as http.IncomingMessage;

                  if (bodyPart.length > 0) {
                    bodyStream.push(bodyPart);
                  }
                  
                  resolve(incomingMessage);
                }
              } else if (incomingMessage) {
                (incomingMessage as any).push(chunk);
              }
            });

            tlsSocket.on("end", () => {
              if (incomingMessage) {
                (incomingMessage as any).push(null);
              }
            });

            tlsSocket.on("error", reject);
          },
        );

        tlsSocket.on("error", reject);
      });

      connectReq.on("error", reject);
      connectReq.end();
    });
  } else {
    // HTTP via proxy (absolute URI)
    return new Promise((resolve, reject) => {
      const proxyPort = proxy.port ? parseInt(proxy.port, 10) : 80;
      const req = http.request(
        {
          hostname: proxy.hostname,
          port: proxyPort,
          path: targetUrl.href,
          method,
          headers: outHeaders,
        },
        (res) => {
          resolve(res);
        },
      );

      req.on("error", reject);
      if (bodyBuffer.length > 0) req.write(bodyBuffer);
      req.end();
    });
  }
}
