import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as http from "node:http";
import { reportReady } from "../callback";

describe("callback", () => {
  describe("reportReady", () => {
    let server: http.Server;
    let serverPort: number;
    let receivedUrl: string | null = null;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          receivedUrl = body;
          res.writeHead(200);
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          serverPort = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      });
    });

    afterAll(() => {
      server.close();
    });

    it("should POST plugin URL to callback server", async () => {
      const originalEnv = process.env.__CALLBACK_URL__;
      process.env.__CALLBACK_URL__ = `http://127.0.0.1:${serverPort}`;

      try {
        await reportReady("http://127.0.0.1:12345");
        expect(receivedUrl).toBe("http://127.0.0.1:12345");
      } finally {
        process.env.__CALLBACK_URL__ = originalEnv;
      }
    });

    it("should not throw when __CALLBACK_URL__ is not set (standalone mode)", async () => {
      const originalEnv = process.env.__CALLBACK_URL__;
      delete process.env.__CALLBACK_URL__;

      try {
        await reportReady("http://127.0.0.1:12345");
        // Should not throw
      } finally {
        if (originalEnv) {
          process.env.__CALLBACK_URL__ = originalEnv;
        }
      }
    });
  });
});
