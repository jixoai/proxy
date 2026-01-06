import { describe, it, expect } from "bun:test";
import { HooksExecutor } from "../src/lib/hooks-executor";
import { streamFromBuffer, readStreamToBuffer } from "@jixo/proxy-plugin";

describe("HooksExecutor config injection", () => {
  it("should pass hook.config into plugin factory", async () => {
    const hooks = [
      {
        type: "http" as const,
        command: "bunx",
        args: ["@jixo/proxy-plugin-anthropic4droid"],
        config: {
          model: "gemini-claude-opus-4-5-thinking",
        },
      },
    ];

    const executor = new HooksExecutor("default", hooks);
    await executor.start();

    const requestBody = {
      model: "claude-opus-4-5-20251101",
      system: "You are Droid, an AI assistant built by Factory.",
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = await executor.executeRequestHooks({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "content-type": "application/json" },
      body: streamFromBuffer(Buffer.from(JSON.stringify(requestBody), "utf-8")),
    });

    const rewrittenText = (await readStreamToBuffer(result.body)).toString("utf-8");
    const rewrittenJson = JSON.parse(rewrittenText);
    expect(rewrittenJson.model).toBe("gemini-claude-opus-4-5-thinking");
  });
});
