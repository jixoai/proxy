/**
 * 正交意图：验证 Bun TLS 重置时的 Node fallback 触发边界。
 * 原始需求输入（2026-08-12）：修复 aiweb.xin 在 Bun 代理中稳定返回 502 的问题。
 */

import { describe, expect, test } from "bun:test";
import { shouldUseNodeHttpsFallback } from "../src/lib/node-https-fallback";

describe("Node HTTPS fallback", () => {
  test("only handles HTTPS socket resets", () => {
    const error = Object.assign(new Error("The socket connection was closed unexpectedly"), {
      code: "ECONNRESET",
    });

    expect(shouldUseNodeHttpsFallback(error, "https:")).toBe(true);
    expect(shouldUseNodeHttpsFallback(error, "http:")).toBe(false);
  });

  test("does not mask unrelated upstream errors", () => {
    const error = Object.assign(new Error("getaddrinfo ENOTFOUND upstream.example"), {
      code: "ENOTFOUND",
    });

    expect(shouldUseNodeHttpsFallback(error, "https:")).toBe(false);
  });
});
