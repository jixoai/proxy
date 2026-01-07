import { describe, it, expect } from "bun:test";
import type { ProxyPlugin } from "@jixo/proxy-plugin";

describe("proxy-server", () => {
  describe("createProxyServer", () => {
    it("should export createProxyServer function", async () => {
      const { createProxyServer } = await import("../proxy-server");
      expect(typeof createProxyServer).toBe("function");
    });
  });

  describe("ProxyPlugin interface compatibility", () => {
    it("should accept a valid ProxyPlugin", () => {
      const plugin: ProxyPlugin = {
        name: "test-plugin",
        async onRequest(params) {
          return { modified: false };
        },
        async onResponse(params) {
          return { modified: false };
        },
      };

      expect(plugin.name).toBe("test-plugin");
      expect(typeof plugin.onRequest).toBe("function");
      expect(typeof plugin.onResponse).toBe("function");
    });

    it("should work with minimal plugin (name only)", () => {
      const plugin: ProxyPlugin = {
        name: "minimal-plugin",
      };

      expect(plugin.name).toBe("minimal-plugin");
      expect(plugin.onRequest).toBeUndefined();
      expect(plugin.onResponse).toBeUndefined();
    });

    it("should work with shouldProcess methods", () => {
      const plugin: ProxyPlugin = {
        name: "precheck-plugin",
        shouldProcessRequest(meta) {
          return meta.url?.includes("/api") ?? false;
        },
        shouldProcessResponse(meta) {
          return meta.statusCode === 200;
        },
      };

      expect(plugin.shouldProcessRequest?.({ url: "/api/test" })).toBe(true);
      expect(plugin.shouldProcessRequest?.({ url: "/other" })).toBe(false);
      expect(plugin.shouldProcessResponse?.({ statusCode: 200 })).toBe(true);
      expect(plugin.shouldProcessResponse?.({ statusCode: 500 })).toBe(false);
    });
  });
});
