import { describe, expect, test } from "bun:test";
import { readStreamToBuffer, streamFromBuffer } from "@jixo/proxy-plugin";
import { createDroidPlugin } from "../plugin";

describe("chat4droid plugin", () => {
  test("flattens tool history into readable transcript (no tool/tool_calls fields)", async () => {
    const plugin = createDroidPlugin();
    const requestBody = {
      model: "claude-opus-4.5",
      stream: true,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "{\"file_path\":\"/tmp/a\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    };

    const result = await plugin.onRequest?.({
      meta: { url: "https://api.hicap.ai/v1/chat/completions", headers: { "content-type": "application/json" } },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    expect(result).toBeTruthy();
    expect("respondWith" in (result as any)).toBe(false);
    expect("modified" in (result as any) && (result as any).modified === false).toBe(false);

    const bodyBuffer = await readStreamToBuffer((result as any).body);
    const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
    expect(parsed.reasoning_effort).toBe("high");
    expect(parsed.messages.some((m: any) => m.role === "tool")).toBe(false);
    expect(parsed.messages.some((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls))).toBe(false);
    expect(parsed.messages.some((m: any) => m.role === "user" && String(m.content || "").includes("Tool result:"))).toBe(
      true,
    );
  });

  test("keeps reasoning_effort when no tool-use history exists", async () => {
    const plugin = createDroidPlugin();
    const requestBody = {
      model: "claude-opus-4.5",
      stream: true,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    };

    const result = await plugin.onRequest?.({
      meta: { url: "https://api.hicap.ai/v1/chat/completions", headers: { "content-type": "application/json" } },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    // No change needed: plugin should skip.
    expect(result).toBeNull();
  });

  test("flattens tool history even when reasoning_effort is missing", async () => {
    const plugin = createDroidPlugin();
    const requestBody = {
      model: "claude-opus-4.5",
      stream: true,
      messages: [
        { role: "system", content: "sys" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "{\"file_path\":\"/tmp/a\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    };

    const result = await plugin.onRequest?.({
      meta: { url: "https://api.hicap.ai/v1/chat/completions", headers: { "content-type": "application/json" } },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    expect(result).toBeTruthy();

    const bodyBuffer = await readStreamToBuffer((result as any).body);
    const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
    expect(parsed.messages.some((m: any) => m.role === "tool")).toBe(false);
    expect(parsed.messages.some((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls))).toBe(false);
  });

  test("bumps max_tokens to >=1707 for claude when reasoning_effort is missing (upstream default behaves like medium)", async () => {
    const plugin = createDroidPlugin();
    const requestBody = {
      model: "claude-opus-4.5",
      max_tokens: 100,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    };

    const result = await plugin.onRequest?.({
      meta: { url: "https://api.hicap.ai/v1/chat/completions", headers: { "content-type": "application/json" } },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    expect(result).toBeTruthy();

    const bodyBuffer = await readStreamToBuffer((result as any).body);
    const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
    expect(parsed.max_tokens).toBe(1707);
  });

  test("injects web_search_options and removes WebSearch function tool", async () => {
    const plugin = createDroidPlugin();
    const requestBody = {
      model: "claude-opus-4.5",
      max_tokens: 1200,
      messages: [{ role: "user", content: "search something" }],
      tools: [
        {
          type: "function",
          function: {
            name: "WebSearch",
            description: "search",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          },
        },
        {
          type: "function",
          function: {
            name: "FetchUrl",
            description: "fetch",
            parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          },
        },
      ],
    };

    const result = await plugin.onRequest?.({
      meta: { url: "https://api.hicap.ai/v1/chat/completions", headers: { "content-type": "application/json" } },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    expect(result).toBeTruthy();
    const bodyBuffer = await readStreamToBuffer((result as any).body);
    const parsed = JSON.parse(bodyBuffer.toString("utf-8"));

    expect(parsed.web_search_options).toBeTruthy();
    expect(parsed.tools.some((t: any) => t?.function?.name === "WebSearch")).toBe(false);
    expect(parsed.tools.some((t: any) => t?.function?.name === "FetchUrl")).toBe(true);
  });

  test("bumps max_tokens to >=1025 for claude when reasoning_effort=high", async () => {
    const plugin = createDroidPlugin();
    const requestBody = {
      model: "claude-opus-4.5",
      reasoning_effort: "high",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    };

    const result = await plugin.onRequest?.({
      meta: { url: "https://api.hicap.ai/v1/chat/completions", headers: { "content-type": "application/json" } },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    expect(result).toBeTruthy();
    const bodyBuffer = await readStreamToBuffer((result as any).body);
    const parsed = JSON.parse(bodyBuffer.toString("utf-8"));
    expect(parsed.max_tokens).toBe(1025);
  });
});
