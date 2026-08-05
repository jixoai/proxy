import { describe, expect, test } from "bun:test";
import { readStreamToBuffer, streamFromBuffer, type ProxyPlugin } from "@jixo/proxy-plugin";
import { HooksExecutor, type LoadedHook } from "../src/lib/hooks-executor";

const textStream = (text: string) => streamFromBuffer(Buffer.from(text, "utf-8"));

const readText = async (stream: ReadableStream<Uint8Array>) =>
  (await readStreamToBuffer(stream)).toString("utf-8");

const asLoadedHook = (plugin: ProxyPlugin): LoadedHook => ({
  pluginName: plugin.name,
  plugin,
});

describe("HooksExecutor request body streams", () => {
  test("keeps the body readable after consuming hooks skip or make no changes", async () => {
    const bodyText = JSON.stringify({ model: "gpt-5", input: "hello" });
    const bodiesSeenByHooks: string[] = [];
    const hooks: LoadedHook[] = [
      asLoadedHook({
        name: "consume-and-skip",
        async onRequest({ body }) {
          bodiesSeenByHooks.push(await readText(body));
          return null;
        },
      }),
      asLoadedHook({
        name: "consume-without-change",
        async onRequest({ body }) {
          bodiesSeenByHooks.push(await readText(body));
          return { modified: false };
        },
      }),
    ];

    const executor = new HooksExecutor("test-instance", null);
    const result = await executor.executeRequestHooksWithLayers(
      {
        method: "POST",
        url: "https://example.com/v1/responses",
        headers: { "content-type": "application/json" },
        body: textStream(bodyText),
      },
      () => null,
      hooks,
    );

    expect(bodiesSeenByHooks).toEqual([bodyText, bodyText]);
    expect(await readText(result.params.body)).toBe(bodyText);
    expect(result.hasChanges).toBe(false);
    expect(result.layers).toEqual([{ pluginName: "consume-without-change", modified: false }]);
  });

  test("passes a replacement body to later hooks without losing it when they skip", async () => {
    const originalBody = JSON.stringify({ model: "gpt-5" });
    const replacementBody = JSON.stringify({ model: "gpt-5-mini" });
    let bodySeenBySecondHook: string | undefined;
    const hooks: LoadedHook[] = [
      asLoadedHook({
        name: "replace-body",
        async onRequest({ body }) {
          expect(await readText(body)).toBe(originalBody);
          return { body: textStream(replacementBody) };
        },
      }),
      asLoadedHook({
        name: "inspect-and-skip",
        async onRequest({ body }) {
          bodySeenBySecondHook = await readText(body);
          return null;
        },
      }),
    ];

    const executor = new HooksExecutor("test-instance", null);
    const result = await executor.executeRequestHooksWithLayers(
      {
        method: "POST",
        url: "https://example.com/v1/responses",
        headers: { "content-type": "application/json" },
        body: textStream(originalBody),
      },
      () => null,
      hooks,
    );

    expect(bodySeenBySecondHook).toBe(replacementBody);
    expect(await readText(result.params.body)).toBe(replacementBody);
    expect(result.hasChanges).toBe(true);
  });
});
