import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { saveConfig, setConfigFilePath, loadConfig } from "../src/lib/config-store";
import { getDataDir, setDataDir } from "../src/lib/runtime-paths";
import { proxyForwardSchema } from "../src/lib/config-schema";
import { ProxyInstancesManager } from "../src/proxy-instances-manager";
import type { HooksConfig, ProviderRoutingConfig } from "../src/types/proxy";

const directory = mkdtempSync(path.join(import.meta.dirname, ".provider-routing-"));
const originalDataDir = getDataDir();
const originalConfigPath = path.resolve(process.env.PROXY_CONFIG_PATH ?? "proxy-config.json");
const manager = new ProxyInstancesManager();
const upstreamRequests: {
  path: string;
  body: string;
  model: string | null;
  targetModel: string | null;
}[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let port: number;
let slowAborted = false;
type Provider = ProviderRoutingConfig & {
  endpoint?: string;
  name?: string;
  path?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  hooks?: HooksConfig;
  timeout?: number;
};

const rewriteHook = (model: string): HooksConfig => ({
  type: "http",
  command: "plugin",
  args: ["@jixo/proxy-plugin-model-rewrite"],
  config: { model },
});
const conversionHook = (name: string): HooksConfig => ({
  type: "http",
  command: "plugin",
  args: [`@jixo/proxy-plugin-${name}`],
});

async function configure(providers: Provider[]) {
  upstreamRequests.length = 0;
  saveConfig({
    instances: [
      {
        name: "routing-test",
        port,
        enabled: true,
        description: null,
        headers: null,
        forwards: providers.map(({ endpoint = "ok", ...config }) =>
          proxyForwardSchema.parse({
            name: "models",
            path: "/group",
            target: `${upstream.url.origin}/${endpoint}`,
            ...config,
          }),
        ),
      },
    ],
  });
  await manager.reloadInstance("routing-test");
}

async function request(
  model: unknown = "local",
  suffix = "/v1/responses",
  extra: Record<string, unknown> = {},
) {
  return fetch(`http://127.0.0.1:${port}/group${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: [], ...extra }),
    signal: AbortSignal.timeout(5000),
  });
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for upstream state");
    await Bun.sleep(10);
  }
}

beforeAll(async () => {
  setDataDir(path.join(directory, "data"));
  upstream = Bun.serve({
    port: 0,
    async fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(req, { data: undefined })) return;
      }
      const pathname = new URL(req.url).pathname;
      const body = await req.text();
      let payload: { model?: string } = {};
      try {
        payload = JSON.parse(body);
      } catch {}
      upstreamRequests.push({
        path: pathname,
        body,
        model: payload?.model ?? null,
        targetModel: req.headers.get("x-target-model"),
      });
      if (pathname.startsWith("/fail"))
        return new Response("provider unavailable", { status: 503 });
      if (pathname.startsWith("/slow")) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2500);
          req.signal.addEventListener(
            "abort",
            () => {
              slowAborted = true;
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      if (pathname.startsWith("/sse"))
        return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      return new Response(JSON.stringify({ path: pathname, ...payload }), {
        headers: { "content-type": "text/plain" },
      });
    },
    websocket: {
      message(socket, message) {
        socket.send(`echo:${message}`);
      },
    },
  });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  port = reservation.port!;
  await reservation.stop(true);
  const configPath = path.join(directory, "proxy-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      instances: [
        {
          name: "routing-test",
          port,
          enabled: true,
          forwards: [
            {
              name: "models",
              path: "/group",
              target: upstream.url.origin,
              modelRouting: {
                mode: "listed",
                models: [{ name: "startup", aliases: ["local"], apiFormats: ["responses"] }],
              },
            },
          ],
        },
      ],
    }),
  );
  setConfigFilePath(configPath);
  await manager.startInstance("routing-test");
  expect((await manager.getInstanceWorkerConfig("routing-test"))?.forwards[0]).toMatchObject({
    modelRouting: {
      mode: "listed",
      models: [{ name: "startup", aliases: ["local"], apiFormats: ["responses"] }],
    },
  });
  expect(await manager.checkInstanceConfigSync("routing-test")).toBe(true);
}, 15000);

afterAll(async () => {
  await manager.stopAll();
  if (upstream) await upstream.stop(true);
  setConfigFilePath(originalConfigPath);
  setDataDir(originalDataDir);
  rmSync(directory, { recursive: true, force: true });
});

test("default provider passes arbitrary models and original JSON bytes", async () => {
  await configure([{}]);
  const body = '{ "model": "arbitrary-new-model", "input": [] }';
  const response = await fetch(`http://127.0.0.1:${port}/group/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(upstreamRequests[0]!.body).toBe(body);
});

test("multiple model names select the right enabled provider in order", async () => {
  await configure([
    {
      endpoint: "disabled",
      enabled: false,
      modelRouting: {
        mode: "listed",
        models: [{ name: "glm-5.3-flash", aliases: [], apiFormats: [] }],
      },
    },
    {
      endpoint: "full",
      modelRouting: { mode: "listed", models: [{ name: "glm-5.3", aliases: [], apiFormats: [] }] },
    },
    {
      endpoint: "flash",
      modelRouting: {
        mode: "listed",
        models: [{ name: "glm-5.3-flash", aliases: [], apiFormats: [] }],
      },
    },
  ]);
  expect((await request("glm-5.3")).status).toBe(200);
  expect((await request("glm-5.3-flash")).status).toBe(200);
  expect(upstreamRequests.map((item) => item.path)).toEqual([
    "/full/v1/responses",
    "/flash/v1/responses",
  ]);
});

test("multiple mappings route by target model and unmatched names still pass without a whitelist", async () => {
  await configure([
    {
      modelRouting: {
        mode: "all",
        models: [
          { name: "glm-5.3", aliases: ["local"], apiFormats: [] },
          { name: "glm-5.3-flash", aliases: ["fast"], apiFormats: [] },
        ],
      },
    },
  ]);
  for (const model of ["local", "fast", "new-model"])
    expect((await request(model)).status).toBe(200);
  expect(upstreamRequests.map((item) => item.model)).toEqual([
    "glm-5.3",
    "glm-5.3-flash",
    "new-model",
  ]);
  await configure([
    {
      modelRouting: {
        mode: "listed",
        models: [{ name: "glm-5.3", aliases: ["local"], apiFormats: [] }],
      },
    },
  ]);
  expect((await request()).status).toBe(200);
  expect(upstreamRequests[0]!.model).toBe("glm-5.3");
});

test("Chinese client aliases map to ASCII target models", async () => {
  await configure([
    {
      modelRouting: {
        mode: "listed",
        models: [{ name: "target-model", aliases: ["中文别名"], apiFormats: [] }],
      },
    },
  ]);
  const response = await request("中文别名");
  expect(response.status).toBe(200);
  await response.text();
  expect(upstreamRequests[0]!.model).toBe("target-model");
  expect(upstreamRequests[0]!.targetModel).toBe("target-model");
});

test("Unicode target models stay in JSON without invalid upstream headers", async () => {
  for (const model of ["中文模型", "模型-🚀"]) {
    await configure([
      {
        modelRouting: {
          mode: "listed",
          models: [{ name: model, aliases: ["local"], apiFormats: [] }],
        },
      },
    ]);
    const response = await request();
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamRequests[0]!.model).toBe(model);
    expect(upstreamRequests[0]!.targetModel).toBeNull();
  }
});

test("configured Unicode target headers are omitted only at the upstream boundary", async () => {
  for (const header of ["x-target-model", "X-Target-Model"]) {
    await configure([{ headers: { [header]: "中文模型" } }]);
    const response = await request();
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamRequests[0]!.model).toBe("local");
    expect(upstreamRequests[0]!.targetModel).toBeNull();
  }
});

test("configured Chinese target headers remain available to conversion hooks", async () => {
  await configure([
    {
      endpoint: "v1/messages",
      path: "/group/v1/responses",
      headers: { "x-target-model": "中文模型" },
      hooks: conversionHook("anthropic4codex"),
    },
  ]);
  const response = await request("local", "/v1/responses", {
    instructions: "Be concise",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(upstreamRequests[0]!.model).toBe("中文模型");
  expect(upstreamRequests[0]!.targetModel).toBeNull();
  expect(JSON.parse(upstreamRequests[0]!.body).messages.length).toBeGreaterThan(0);
});

test("Chinese model mappings remain available to conversion hooks", async () => {
  await configure([
    {
      endpoint: "v1/messages",
      path: "/group/v1/responses",
      hooks: conversionHook("anthropic4codex"),
      modelRouting: {
        mode: "listed",
        models: [{ name: "中文模型", aliases: ["local"], apiFormats: ["responses"] }],
      },
    },
  ]);
  const response = await request("local", "/v1/responses", {
    instructions: "Be concise",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(upstreamRequests[0]!.model).toBe("中文模型");
  expect(upstreamRequests[0]!.path).toBe("/v1/messages");
  expect(upstreamRequests[0]!.targetModel).toBeNull();
  expect(JSON.parse(upstreamRequests[0]!.body).messages.length).toBeGreaterThan(0);
});

test("concurrent model requests keep provider selection and mappings isolated", async () => {
  await configure([
    {
      endpoint: "full",
      modelRouting: {
        mode: "listed",
        models: [{ name: "glm-5.3", aliases: ["local"], apiFormats: [] }],
      },
    },
    {
      endpoint: "flash",
      modelRouting: {
        mode: "listed",
        models: [{ name: "glm-5.3-flash", aliases: ["fast"], apiFormats: [] }],
      },
    },
  ]);
  await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const response = await request(index % 2 ? "fast" : "local");
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.model).toBe(index % 2 ? "glm-5.3-flash" : "glm-5.3");
      expect(result.path).toBe(index % 2 ? "/flash/v1/responses" : "/full/v1/responses");
    }),
  );
  expect(upstreamRequests).toHaveLength(12);
});

test("two models on the same provider have independent APIs, including aliases and unknown defaults", async () => {
  await configure([
    {
      endpoint: "primary",
      modelRouting: {
        mode: "all",
        models: [
          { name: "glm-5.3", aliases: ["local"], apiFormats: ["responses"] },
          { name: "glm-5.3-flash", aliases: ["fast"], apiFormats: ["anthropic-messages"] },
        ],
      },
    },
    {
      endpoint: "fallback",
      modelRouting: {
        mode: "listed",
        models: [
          { name: "glm-5.3", aliases: ["local"], apiFormats: ["anthropic-messages"] },
          { name: "glm-5.3-flash", aliases: ["fast"], apiFormats: ["responses"] },
        ],
      },
    },
  ]);
  for (const model of ["local", "glm-5.3"]) {
    expect((await request(model)).status).toBe(200);
    expect(upstreamRequests.at(-1)).toMatchObject({
      path: "/primary/v1/responses",
      model: "glm-5.3",
    });
    expect((await request(model, "/v1/messages")).status).toBe(200);
    expect(upstreamRequests.at(-1)).toMatchObject({
      path: "/fallback/v1/messages",
      model: "glm-5.3",
    });
  }
  for (const model of ["fast", "glm-5.3-flash"]) {
    expect((await request(model)).status).toBe(200);
    expect(upstreamRequests.at(-1)).toMatchObject({
      path: "/fallback/v1/responses",
      model: "glm-5.3-flash",
    });
    expect((await request(model, "/v1/messages")).status).toBe(200);
    expect(upstreamRequests.at(-1)).toMatchObject({
      path: "/primary/v1/messages",
      model: "glm-5.3-flash",
    });
  }
  for (const suffix of ["/v1/responses", "/v1/messages", "/v1/chat/completions"]) {
    expect((await request("unknown", suffix)).status).toBe(200);
    expect(upstreamRequests.at(-1)).toMatchObject({ path: `/primary${suffix}`, model: "unknown" });
  }
});

test("legacy-hook final model API is enforced before forwarding", async () => {
  await configure([
    {
      endpoint: "wrong",
      modelRouting: {
        mode: "all",
        models: [{ name: "legacy", apiFormats: ["anthropic-messages"] }],
      },
      hooks: rewriteHook("legacy"),
    },
    { endpoint: "fallback" },
  ]);
  expect((await request()).status).toBe(200);
  expect(upstreamRequests.map((item) => item.path)).toEqual(["/fallback/v1/responses"]);
});

test("fallback remaps each provider from the original body", async () => {
  await configure([
    {
      endpoint: "fail",
      modelRouting: {
        mode: "listed",
        models: [{ name: "first", aliases: ["local"], apiFormats: [] }],
      },
    },
    {
      endpoint: "ok",
      modelRouting: {
        mode: "listed",
        models: [{ name: "second", aliases: ["local"], apiFormats: [] }],
      },
    },
  ]);
  const response = await request("local", "/v1/responses", { metadata: { keep: true } });
  expect(response.status).toBe(200);
  expect((await response.json()).model).toBe("second");
  expect(upstreamRequests.map((item) => item.model)).toEqual(["first", "second"]);
  expect(upstreamRequests.every((item) => JSON.parse(item.body).metadata.keep)).toBe(true);
});

test("API filtering and per-model restrictions skip incompatible providers", async () => {
  await configure([
    {
      endpoint: "messages",
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["anthropic-messages"] }],
      },
    },
    {
      endpoint: "flash",
      modelRouting: {
        mode: "all",
        models: [{ name: "flash", aliases: ["local"], apiFormats: ["anthropic-messages"] }],
      },
    },
    {
      endpoint: "responses",
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["responses"] }],
      },
    },
  ]);
  expect((await request()).status).toBe(200);
  expect(upstreamRequests.map((item) => item.path)).toEqual(["/responses/v1/responses"]);
  expect((await request("local", "/v1/messages")).status).toBe(200);
  expect(upstreamRequests.at(-1)!.path).toBe("/messages/v1/messages");
});

test("provider matching starts with the original client name even when upstream names differ", async () => {
  await configure([
    {
      endpoint: "not-called",
      modelRouting: {
        mode: "listed",
        models: [
          { name: "vendor-messages/glm", aliases: ["glm-5.3"], apiFormats: ["anthropic-messages"] },
        ],
      },
    },
    {
      endpoint: "fail",
      modelRouting: {
        mode: "listed",
        models: [{ name: "vendor-a/glm-full", aliases: ["glm-5.3"], apiFormats: ["responses"] }],
      },
    },
    {
      endpoint: "ok",
      modelRouting: {
        mode: "listed",
        models: [{ name: "vendor-b/glm-v5", aliases: ["glm-5.3"], apiFormats: ["responses"] }],
      },
    },
  ]);
  const response = await request("glm-5.3");
  expect(response.status).toBe(200);
  expect((await response.json()).model).toBe("vendor-b/glm-v5");
  expect(upstreamRequests.map((item) => ({ path: item.path, model: item.model }))).toEqual([
    { path: "/fail/v1/responses", model: "vendor-a/glm-full" },
    { path: "/ok/v1/responses", model: "vendor-b/glm-v5" },
  ]);
});

test("Chat Completions and per-model API declarations filter by the original protocol", async () => {
  await configure([
    {
      endpoint: "wrong",
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["responses"] }],
      },
    },
    {
      endpoint: "model-api",
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["anthropic-messages"] }],
      },
    },
    {
      endpoint: "chat",
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["chat-completions"] }],
      },
    },
  ]);
  expect((await request("local", "/v1/chat/completions")).status).toBe(200);
  expect(upstreamRequests.map((item) => item.path)).toEqual(["/chat/v1/chat/completions"]);
  await configure([
    {
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["anthropic-messages"] }],
      },
    },
  ]);
  expect((await request()).status).toBe(422);
  expect(upstreamRequests).toHaveLength(0);
});

test("no compatible provider returns 422 with no upstream call or unrelated fallback", async () => {
  await configure([
    { modelRouting: { mode: "listed", models: [{ name: "other", aliases: [], apiFormats: [] }] } },
    { name: "unrelated", path: "/other" },
  ]);
  const response = await request();
  expect(response.status).toBe(422);
  expect((await response.json()).error).toMatchObject({
    code: "no_compatible_provider",
    group: "models",
    model: "local",
    apiFormat: "responses",
  });
  expect(upstreamRequests).toHaveLength(0);
});

test("missing and invalid models return 400 only when explicit restrictions require them", async () => {
  await configure([
    { modelRouting: { mode: "listed", models: [{ name: "target", aliases: [], apiFormats: [] }] } },
  ]);
  for (const model of [null, 123, ""]) expect((await request(model)).status).toBe(400);
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/group/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(400);
  const malformed = await fetch(`http://127.0.0.1:${port}/group/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).error.message).toContain("Invalid JSON");
  expect(upstreamRequests).toHaveLength(0);
  await configure([{}]);
  expect((await request(null)).status).toBe(200);
});

test("generic requests and model-list GET do not require a model", async () => {
  await configure([
    {
      modelRouting: {
        mode: "listed",
        models: [{ name: "target", aliases: [], apiFormats: ["responses"] }],
      },
    },
  ]);
  expect((await fetch(`http://127.0.0.1:${port}/group/v1/models`)).status).toBe(200);
  expect(
    (await fetch(`http://127.0.0.1:${port}/group/health`, { method: "POST", body: "not-json" }))
      .status,
  ).toBe(200);
  expect(upstreamRequests).toHaveLength(2);
});

test("legacy model hook is checked after rewriting, new mapping takes precedence", async () => {
  await configure([
    {
      hooks: rewriteHook("legacy"),
      modelRouting: { mode: "listed", models: [{ name: "legacy", aliases: [], apiFormats: [] }] },
    },
  ]);
  expect((await request()).status).toBe(200);
  expect(upstreamRequests[0]!.model).toBe("legacy");
  await configure([
    {
      hooks: rewriteHook("wrong"),
      modelRouting: { mode: "listed", models: [{ name: "target", aliases: [], apiFormats: [] }] },
    },
    { endpoint: "fallback" },
  ]);
  expect((await request()).status).toBe(200);
  expect(upstreamRequests.map((item) => item.path)).toEqual(["/fallback/v1/responses"]);
  await configure([
    {
      headers: { "x-target-model": "old" },
      hooks: rewriteHook("wrong"),
      modelRouting: {
        mode: "listed",
        models: [{ name: "mapped", aliases: ["local"], apiFormats: [] }],
      },
    },
  ]);
  expect((await request()).status).toBe(200);
  expect(upstreamRequests[0]!.model).toBe("mapped");
  expect(upstreamRequests[0]!.targetModel).toBe("mapped");
});

test("Responses conversion hooks see the mapped model and client-facing API declaration", async () => {
  await configure([
    {
      endpoint: "v1/messages",
      path: "/group/v1/responses",
      hooks: conversionHook("anthropic4codex"),
      modelRouting: {
        mode: "listed",
        models: [{ name: "mapped", aliases: ["local"], apiFormats: ["responses"] }],
      },
    },
  ]);
  const response = await request("local", "/v1/responses", {
    instructions: "Be concise",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(upstreamRequests[0]!.model).toBe("mapped");
  expect(upstreamRequests[0]!.path).toBe("/v1/messages");
  expect(JSON.parse(upstreamRequests[0]!.body).messages.length).toBeGreaterThan(0);
});

test("Messages conversion and count_tokens retain their existing behavior", async () => {
  await configure([
    {
      endpoint: "v1/responses",
      path: "/group/v1/messages",
      hooks: conversionHook("responses4claudecode"),
      modelRouting: {
        mode: "listed",
        models: [{ name: "mapped", aliases: ["local"], apiFormats: ["anthropic-messages"] }],
      },
    },
  ]);
  const response = await request("local", "/v1/messages", {
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(upstreamRequests[0]!.path).toBe("/v1/responses");
  expect(upstreamRequests[0]!.model).toBe("mapped");
  const beforeCount = upstreamRequests.length;
  const count = await request("local", "/v1/messages/count_tokens", {
    messages: [{ role: "user", content: "hi" }],
  });
  expect(count.status).toBe(200);
  expect((await count.json()).input_tokens).toBeGreaterThan(0);
  expect(upstreamRequests.length).toBe(beforeCount);
});

test("local hook responses cannot bypass explicit model restrictions", async () => {
  await configure([
    {
      hooks: conversionHook("responses4claudecode"),
      modelRouting: {
        mode: "listed",
        models: [{ name: "supported", aliases: [], apiFormats: ["anthropic-messages"] }],
      },
    },
  ]);
  const rejected = await request("unlisted", "/v1/messages/count_tokens", {
    messages: [{ role: "user", content: "hi" }],
  });
  expect(rejected.status).toBe(422);
  expect((await rejected.json()).error.code).toBe("no_compatible_provider");
  expect(upstreamRequests).toHaveLength(0);
  expect(
    (
      await request("supported", "/v1/messages/count_tokens", {
        messages: [{ role: "user", content: "hi" }],
      })
    ).status,
  ).toBe(200);
});

test("compact endpoint uses Responses capability and model mapping", async () => {
  await configure([
    {
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["anthropic-messages"] }],
      },
    },
    {
      modelRouting: {
        mode: "all",
        models: [{ name: "compact-model", aliases: ["local"], apiFormats: ["responses"] }],
      },
    },
  ]);
  expect((await request("local", "/v1/responses/compact")).status).toBe(200);
  expect(upstreamRequests).toHaveLength(1);
  expect(upstreamRequests[0]!.model).toBe("compact-model");
});

test("Droid alias fallback retains source hooks but uses transport model mapping", async () => {
  await configure([
    {
      name: "droid",
      path: "/droid",
      endpoint: "fail",
      hooks: rewriteHook("old-hook"),
      modelRouting: {
        mode: "all",
        models: [{ name: "first", aliases: ["local"], apiFormats: [] }],
      },
    },
    {
      name: "anthropic",
      path: "/anthropic",
      endpoint: "ok",
      modelRouting: {
        mode: "listed",
        models: [{ name: "second", aliases: ["local"], apiFormats: [] }],
      },
    },
  ]);
  const response = await fetch(`http://127.0.0.1:${port}/droid/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local", messages: [] }),
  });
  expect(response.status).toBe(200);
  expect(upstreamRequests.map((item) => item.model)).toEqual(["first", "second"]);
});

test("SSE mapping streams without trying a second provider after success", async () => {
  await configure([
    {
      endpoint: "sse",
      modelRouting: {
        mode: "all",
        models: [{ name: "stream-model", aliases: ["local"], apiFormats: [] }],
      },
    },
    { endpoint: "not-used" },
  ]);
  const response = await request("local", "/v1/responses", { stream: true });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toContain("[DONE]");
  expect(upstreamRequests).toHaveLength(1);
  expect(upstreamRequests[0]!.model).toBe("stream-model");
});

test("Droid fallback checks the transport model's API, not the source model's API", async () => {
  await configure([
    {
      name: "droid",
      path: "/droid",
      endpoint: "not-called",
      modelRouting: {
        mode: "all",
        models: [{ name: "first", aliases: ["local"], apiFormats: ["responses"] }],
      },
      hooks: rewriteHook("legacy"),
    },
    {
      name: "anthropic",
      path: "/anthropic",
      endpoint: "transport",
      modelRouting: {
        mode: "listed",
        models: [{ name: "second", aliases: ["local"], apiFormats: ["anthropic-messages"] }],
      },
    },
  ]);
  const response = await fetch(`http://127.0.0.1:${port}/droid/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local", messages: [] }),
  });
  expect(response.status).toBe(200);
  expect(upstreamRequests).toHaveLength(1);
  expect(upstreamRequests[0]).toMatchObject({ model: "second", path: "/transport/v1/messages" });
});

test("client abort cancels mapped upstream without fallback", async () => {
  slowAborted = false;
  await configure([
    {
      endpoint: "slow",
      modelRouting: {
        mode: "all",
        models: [{ name: "slow-model", aliases: ["local"], apiFormats: [] }],
      },
    },
    { endpoint: "not-used" },
  ]);
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/group/v1/responses`, {
    method: "POST",
    body: JSON.stringify({ model: "local" }),
    headers: { "content-type": "application/json" },
    signal: controller.signal,
  }).catch(() => null);
  await waitFor(() => upstreamRequests.length > 0);
  controller.abort();
  expect(await pending).toBeNull();
  await waitFor(() => slowAborted);
  expect(upstreamRequests).toHaveLength(1);
});

test("timeout preserves request-wide abort semantics without replaying to another provider", async () => {
  await configure([
    {
      endpoint: "slow",
      timeout: 1,
      modelRouting: {
        mode: "all",
        models: [{ name: "slow-model", aliases: ["local"], apiFormats: [] }],
      },
    },
    {
      modelRouting: {
        mode: "all",
        models: [{ name: "fast-model", aliases: ["local"], apiFormats: [] }],
      },
    },
  ]);
  const response = await request();
  expect(response.status).toBe(504);
  expect(upstreamRequests.map((item) => item.model)).toEqual(["slow-model"]);
});

test("capabilities survive worker snapshots and reload changes affect subsequent requests", async () => {
  const routing: ProviderRoutingConfig = {
    modelRouting: {
      mode: "listed",
      models: [{ name: "mapped", aliases: ["local"], apiFormats: ["responses"] }],
    },
  };
  await configure([routing]);
  expect((await manager.getInstanceWorkerConfig("routing-test"))?.forwards[0]).toMatchObject(
    routing,
  );
  expect(await manager.checkInstanceConfigSync("routing-test")).toBe(true);
  expect(loadConfig().instances[0]!.forwards[0]).toMatchObject(routing);
  expect((await request()).status).toBe(200);
  await configure([
    { modelRouting: { mode: "listed", models: [{ name: "other", aliases: [], apiFormats: [] }] } },
  ]);
  expect((await request()).status).toBe(422);
  expect(await manager.checkInstanceConfigSync("routing-test")).toBe(true);
  await configure([{ modelRouting: null }]);
  expect((await request("new")).status).toBe(200);
  expect(await manager.checkInstanceConfigSync("routing-test")).toBe(true);
});

test("WebSocket restrictions reject upgrade explicitly", async () => {
  for (const routing of [
    { modelRouting: { mode: "listed", models: [{ name: "local", aliases: [], apiFormats: [] }] } },
    {
      modelRouting: {
        mode: "all",
        models: [{ name: "target", aliases: ["local"], apiFormats: [] }],
      },
    },
    {
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["responses"] }],
      },
    },
    {
      modelRouting: {
        mode: "all",
        models: [{ name: "local", aliases: [], apiFormats: ["responses"] }],
      },
    },
  ]) {
    await configure([routing as ProviderRoutingConfig]);
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/group/responses`,
        {
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
          signal: AbortSignal.timeout(3000),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(result.status).toBe(422);
    expect(JSON.parse(result.body).error.code).toBe("websocket_model_routing_not_supported");
  }
});

test("unrestricted WebSocket still proxies frames", async () => {
  await configure([{}]);
  const result = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/group/socket`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket timeout"));
    }, 3000);
    socket.onopen = () => socket.send("hello");
    socket.onmessage = (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(String(event.data));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("WebSocket connection failed"));
    };
  });
  expect(result).toBe("echo:hello");
});
