import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import type { Socket } from "node:net";
import { createWebSocketMessage } from "./db-requests";
import type { Duplex } from "node:stream";

// WebSocket 帧解析器（简化版本）
interface WebSocketFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

/**
 * 解析 WebSocket 帧
 * 参考: RFC 6455
 */
function parseWebSocketFrame(buffer: Buffer): WebSocketFrame | null {
  if (buffer.length < 2) return null;

  const byte1 = buffer[0];
  const byte2 = buffer[1];

  if (byte1 === undefined || byte2 === undefined) return null;

  const fin = (byte1 & 0x80) === 0x80;
  const opcode = byte1 & 0x0f;
  const masked = (byte2 & 0x80) === 0x80;
  let payloadLength = byte2 & 0x7f;

  let offset = 2;

  // 处理扩展payload长度
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    // 读取 64 位长度（只使用低 32 位）
    payloadLength = buffer.readUInt32BE(6);
    offset = 10;
  }

  // Mask key
  let maskKey: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  // Payload
  if (buffer.length < offset + payloadLength) return null;
  let payload = buffer.subarray(offset, offset + payloadLength);

  // 如果有mask，解码payload
  if (masked && maskKey) {
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      const payloadByte = payload[i];
      const maskByte = maskKey[i % 4];
      if (payloadByte !== undefined && maskByte !== undefined) {
        unmasked[i] = payloadByte ^ maskByte;
      }
    }
    payload = unmasked;
  }

  return { fin, opcode, masked, payload };
}

/**
 * 生成 WebSocket 帧
 */
function createWebSocketFrame(payload: Buffer, opcode = 0x01): Buffer {
  const payloadLength = payload.length;
  let frameLength = 2 + payloadLength;
  let offset = 2;

  if (payloadLength > 125) {
    if (payloadLength <= 0xffff) {
      frameLength = 4 + payloadLength;
      offset = 4;
    } else {
      frameLength = 10 + payloadLength;
      offset = 10;
    }
  }

  const frame = Buffer.alloc(frameLength);

  // Byte 1: FIN + opcode
  frame[0] = 0x80 | opcode; // FIN=1, opcode

  // Byte 2: MASK + payload length
  if (payloadLength <= 125) {
    frame[1] = payloadLength;
  } else if (payloadLength <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(payloadLength, 2);
  } else {
    frame[1] = 127;
    frame.writeUInt32BE(0, 2); // 高32位
    frame.writeUInt32BE(payloadLength, 6); // 低32位
  }

  // Payload
  payload.copy(frame, offset);

  return frame;
}

/**
 * 处理 WebSocket 升级请求并进行代理
 */
export function handleWebSocketProxy(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  targetUrl: URL,
  instanceName: string,
  forwardName: string | null,
) {
  console.log("\n" + "🔌".repeat(40));
  console.log(`[WebSocket] 升级请求`);
  console.log(`目标 URL: ${targetUrl.href.replace("http", "ws")}`);
  console.log("🔌".repeat(40) + "\n");

  const connectionId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  let messageIndex = 0;

  // 选择协议模块
  const isSecure = targetUrl.protocol === "https:";
  const requestModule = isSecure ? https : http;
  const wsUrl = targetUrl.href.replace(/^http/, "ws");

  // 创建到目标服务器的 HTTP 请求（用于升级）
  const proxyReq = requestModule.request({
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isSecure ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: "GET",
    headers: {
      ...req.headers,
      host: targetUrl.host,
      // WebSocket 升级必需的头
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": req.headers["sec-websocket-version"] || "13",
      "Sec-WebSocket-Key": req.headers["sec-websocket-key"] || "",
    },
  });

  // 处理升级响应
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    console.log(`[WebSocket] 连接已建立`);

    // 将升级响应发送给客户端
    clientSocket.write(
      `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`,
    );
    Object.entries(proxyRes.headers).forEach(([key, value]) => {
      clientSocket.write(`${key}: ${value}\r\n`);
    });
    clientSocket.write("\r\n");

    // 如果有 head 数据，发送给客户端
    if (proxyHead && proxyHead.length > 0) {
      clientSocket.write(proxyHead);
    }

    // 双向数据转发 + 消息拦截记录

    // 客户端 -> 服务器 (send)
    clientSocket.on("data", (data: Buffer) => {
      // 尝试解析 WebSocket 帧
      const frame = parseWebSocketFrame(data);

      if (frame && (frame.opcode === 0x01 || frame.opcode === 0x02)) {
        // 0x01 = text frame, 0x02 = binary frame
        const messageType = frame.opcode === 0x01 ? "text" : "binary";
        const displayPayload =
          frame.opcode === 0x01
            ? frame.payload.toString("utf-8")
            : `<binary ${frame.payload.length} bytes>`;

        console.log(
          `[WebSocket → Server] ${messageType}: ${displayPayload.substring(0, 200)}`,
        );

        // 记录到数据库
        try {
          createWebSocketMessage({
            instance_name: instanceName,
            forward_name: forwardName,
            connection_id: connectionId,
            message_index: ++messageIndex,
            direction: "send",
            url: wsUrl,
            message: frame.payload,
          });
        } catch (error) {
          console.error("[WebSocket] 数据库记录失败:", error);
        }
      }

      // 转发原始数据到目标服务器
      proxySocket.write(data);
    });

    // 服务器 -> 客户端 (receive)
    proxySocket.on("data", (data: Buffer) => {
      // 尝试解析 WebSocket 帧
      const frame = parseWebSocketFrame(data);

      if (frame && (frame.opcode === 0x01 || frame.opcode === 0x02)) {
        const messageType = frame.opcode === 0x01 ? "text" : "binary";
        const displayPayload =
          frame.opcode === 0x01
            ? frame.payload.toString("utf-8")
            : `<binary ${frame.payload.length} bytes>`;

        console.log(
          `[WebSocket ← Server] ${messageType}: ${displayPayload.substring(0, 200)}`,
        );

        // 记录到数据库
        try {
          createWebSocketMessage({
            instance_name: instanceName,
            forward_name: forwardName,
            connection_id: connectionId,
            message_index: ++messageIndex,
            direction: "receive",
            url: wsUrl,
            message: frame.payload,
          });
        } catch (error) {
          console.error("[WebSocket] 数据库记录失败:", error);
        }
      }

      // 转发原始数据到客户端
      clientSocket.write(data);
    });

    // 错误处理
    const cleanup = () => {
      console.log(`[WebSocket] 连接关闭: ${wsUrl}`);
      clientSocket.end();
      proxySocket.end();
    };

    clientSocket.on("error", (err) => {
      console.error("[WebSocket] 客户端错误:", err.message);
      cleanup();
    });

    proxySocket.on("error", (err) => {
      console.error("[WebSocket] 服务器错误:", err.message);
      cleanup();
    });

    clientSocket.on("close", cleanup);
    proxySocket.on("close", cleanup);
  });

  // 升级失败处理
  proxyReq.on("error", (error) => {
    console.error("[WebSocket] 升级失败:", error.message);
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.end();
  });

  // 发送升级请求
  proxyReq.end();

  // 将 head 数据写入代理请求
  if (head && head.length > 0) {
    proxyReq.write(head);
  }
}
