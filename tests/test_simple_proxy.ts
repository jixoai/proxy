const server = Bun.serve({
  port: 30002,
  fetch(req) {
    const url = new URL(req.url);
    url.protocol = "http:";
    url.host = "localhost:10002";
    console.log(url.href);
    return fetch(url, req);
  },
});

console.log("Server running at", server.url.href);

import { filterResponseProxyHeaders } from "@/lib/filter-proxy-headers";
import http from "node:http";

{
  const server = http.createServer((req, res) => {
    const proxyReq = http.request(
      {
        hostname: "localhost",
        port: 10002,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(
          proxyRes.statusCode ?? 200,
          filterResponseProxyHeaders(proxyRes.headers),
        );
        proxyRes.pipe(res);
      },
    );
    req.pipe(proxyReq);
  });
  server.listen(40002, () => {
    console.log(`Server running at http://localhost:40002/`);
  });
}
