import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

/**
 * 一个包含标准 HTTP 逐跳（Hop-by-Hop）头部的 Set 集合。
 * 这些头部定义了两个直接相连节点之间的连接特性，不应该被代理服务器转发。
 * 使用 Set 数据结构可以提供 O(1) 的平均时间复杂度进行查找，性能极高。
 * 键已全部转换为小写，以便进行不区分大小写的比较。
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers#hop-by-hop_headers
 * @see https://www.rfc-editor.org/rfc/rfc2616#section-13.5.1
 */
const HOP_BY_HOP_HEADERS: Set<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/**
 * 过滤传入的 HTTP 头部对象，移除所有逐跳（Hop-by-Hop）头部，使其适用于代理转发。
 *
 * 此函数会创建一个新的头部对象，而不会修改原始传入的对象（不可变性原则）。
 * 它会处理标准的逐跳头部，以及由 'Connection' 头部动态指定的其他逐跳头部。
 *
 * @param {IncomingHttpHeaders} incomingHeaders - 从上游服务（例如，在 http.request 的回调中收到的 `proxyRes.headers`）接收的原始头部对象。
 * @returns {OutgoingHttpHeaders} 一个净化后的新头部对象，只包含端到端（End-to-End）头部，可以安全地发送给下游客户端。
 */
export function filterResponseProxyHeaders(
  incomingHeaders: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const outgoingHeaders: OutgoingHttpHeaders = {};

  // 1. 首先处理 'Connection' 头，它可能包含需要移除的额外头部名称列表。
  const additionalHops = new Set<string>();
  const connectionHeaderValue = incomingHeaders["connection"];
  if (typeof connectionHeaderValue === "string") {
    connectionHeaderValue.split(",").forEach((headerName) => {
      additionalHops.add(headerName.trim().toLowerCase());
    });
  }

  // 2. 遍历所有传入的头部。
  for (const key in incomingHeaders) {
    // 确保我们只处理对象自身的属性，这是一个健壮性检查。
    if (!Object.prototype.hasOwnProperty.call(incomingHeaders, key)) {
      continue;
    }

    const lowerCaseKey = key.toLowerCase();

    // 3. 核心过滤逻辑：如果头部是标准的逐跳头部，或在 'Connection' 头中被指定为逐跳，则跳过。
    if (
      HOP_BY_HOP_HEADERS.has(lowerCaseKey) ||
      additionalHops.has(lowerCaseKey)
    ) {
      continue;
    }

    // 4. 如果该头部是安全的端到端头部，则将其复制到新的传出头部对象中。
    outgoingHeaders[key] = incomingHeaders[key];
  }

  return outgoingHeaders;
}
