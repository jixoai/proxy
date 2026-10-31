import { describe, expect, test } from "bun:test";
import type { ModelRouting, ProviderRoutingConfig } from "../src/types/proxy";
import { proxyForwardSchema, parseConfigFile, serializeConfigFile } from "../src/lib/config-schema";
import {
  getProviderRoutingConfig,
  providerRoutingSchema,
  modelRoutingFingerprint,
} from "../src/lib/provider-routing-config";
import { createModelRoutingDraft, parseModelRoutingDraft } from "../src/lib/provider-routing-form";
import {
  createModelRoutingDraftStore,
  createModelRoutingSession,
} from "../src/lib/model-routing-drafts";
import {
  hasProviderRouting,
  hasProviderModelAlias,
  identifyApiFormat,
  inspectModelRequest,
  providerIncompatibility,
  resolveProviderModel,
  rewriteRequestModel,
} from "../src/lib/provider-routing";

const body = (payload: unknown) => Buffer.from(JSON.stringify(payload));
const request = inspectModelRequest(
  body({ model: "local" }),
  "POST",
  "/group/v1/responses",
  "/group",
);
const routing: ModelRouting = {
  mode: "all",
  models: [
    { name: "glm-5.3", aliases: ["local"], apiFormats: ["responses"] },
    { name: "glm-5.3-flash", aliases: ["fast"], apiFormats: ["anthropic-messages"] },
  ],
};

describe("model capabilities", () => {
  test("omitted, null and empty all declarations mean unrestricted", () => {
    for (const input of [
      {},
      { modelRouting: null },
      { modelRouting: {} },
      { modelRouting: { mode: "all", models: [] } },
    ]) {
      const config = providerRoutingSchema.parse(input);
      expect(hasProviderRouting(config)).toBe(false);
      expect(resolveProviderModel(config, "local")).toBe("local");
      expect(providerIncompatibility(config, request, "local")).toBeNull();
      expect(config.modelRouting).toBeNull();
    }
  });

  test("trims names, deduplicates aliases/APIs and removes own-name aliases", () => {
    expect(
      providerRoutingSchema.parse({
        modelRouting: {
          models: [
            {
              name: " glm ",
              aliases: [" local ", "local", "glm"],
              apiFormats: ["responses", "responses"],
            },
          ],
        },
      }).modelRouting,
    ).toEqual({
      mode: "all",
      models: [{ name: "glm", aliases: ["local"], apiFormats: ["responses"] }],
    });
  });

  test("rejects all legacy fields even when empty or null", () => {
    for (const field of ["models", "modelMapping", "apiFormats", "modelApiFormats"]) {
      for (const value of [null, [], {}, ["responses"]]) {
        const parsed = providerRoutingSchema.safeParse({ [field]: value });
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues[0]!.message).toContain("旧模型字段已移除");
      }
    }
  });

  test("rejects empty listed mode, invalid entries and cross-row conflicts", () => {
    for (const modelRouting of [
      { mode: "listed", models: [] },
      { models: [{ name: " " }] },
      { models: [{ name: "target", apiFormats: ["unknown"] }] },
      { models: [{ name: "same" }, { name: "same" }] },
      {
        models: [
          { name: "one", aliases: ["local"] },
          { name: "two", aliases: [" local "] },
        ],
      },
      { models: [{ name: "one", aliases: ["two"] }, { name: "two" }] },
      { models: [{ name: "one" }, { name: "two", aliases: ["one"] }] },
      { apiFormats: ["responses"] },
    ])
      expect(providerRoutingSchema.safeParse({ modelRouting }).success).toBe(false);
  });

  test("aliases are exact, case-sensitive and do not create a whitelist", () => {
    const config = { modelRouting: routing };
    expect(resolveProviderModel(config, "local")).toBe("glm-5.3");
    expect(resolveProviderModel(config, "fast")).toBe("glm-5.3-flash");
    for (const model of ["Local", "toString", "unknown", null])
      expect(resolveProviderModel(config, model)).toBe(model);
    expect(hasProviderModelAlias(config, "local")).toBe(true);
    expect(hasProviderModelAlias(config, "glm-5.3")).toBe(false);
    expect(providerIncompatibility(config, request, "unknown")).toBeNull();
    expect(
      providerIncompatibility(config, { ...request, apiFormat: "chat-completions" }, "unknown"),
    ).toBeNull();
  });

  test("each model and its aliases use that model's API without provider-wide inheritance", () => {
    const config = { modelRouting: routing };
    for (const name of ["local", "glm-5.3"])
      expect(
        providerIncompatibility(config, request, resolveProviderModel(config, name)),
      ).toBeNull();
    for (const name of ["fast", "glm-5.3-flash"]) {
      expect(providerIncompatibility(config, request, resolveProviderModel(config, name))).toBe(
        "api_not_supported",
      );
      expect(
        providerIncompatibility(
          config,
          { ...request, apiFormat: "anthropic-messages" },
          resolveProviderModel(config, name),
        ),
      ).toBeNull();
    }
    expect(
      providerIncompatibility(config, { ...request, apiFormat: null }, "glm-5.3-flash"),
    ).toBeNull();
  });

  test("listed mode checks canonical targets and missing models", () => {
    const config: ProviderRoutingConfig = { modelRouting: { ...routing, mode: "listed" } };
    expect(providerIncompatibility(config, request, "unknown")).toBe("model_not_supported");
    expect(providerIncompatibility(config, request, "local")).toBe("model_not_supported");
    expect(
      providerIncompatibility(config, request, resolveProviderModel(config, "local")),
    ).toBeNull();
    expect(providerIncompatibility(config, { ...request, model: null }, null)).toBe(
      "missing_model",
    );
    expect(providerIncompatibility(config, { ...request, requiresModel: false }, null)).toBeNull();
  });

  test("legacy hooks defer both model and per-model API checks until final target is known", () => {
    expect(
      providerIncompatibility(
        { modelRouting: { ...routing, mode: "listed" } },
        request,
        "unknown",
        true,
      ),
    ).toBeNull();
    expect(
      providerIncompatibility({ modelRouting: routing }, request, "glm-5.3-flash", true),
    ).toBeNull();
  });

  test("only configured routes require the explicit WebSocket guard", () => {
    expect(hasProviderRouting({})).toBe(false);
    expect(hasProviderRouting({ modelRouting: routing })).toBe(true);
    expect(
      hasProviderRouting({ modelRouting: { mode: "listed", models: [{ name: "target" }] } }),
    ).toBe(true);
  });
});

describe("HTTP request inspection", () => {
  test("identifies HTTP API variants and exact group prefixes", () => {
    expect(identifyApiFormat("/v1/responses/compact")).toBe("responses");
    expect(identifyApiFormat("/group/messages/count_tokens", "/group")).toBe("anthropic-messages");
    expect(identifyApiFormat("/v1/chat/completions/")).toBe("chat-completions");
    expect(identifyApiFormat("/v1/messages", "/v1/messages")).toBe("anthropic-messages");
    expect(identifyApiFormat("/group/v1/responses", "/group/v1/responses")).toBe("responses");
    expect(identifyApiFormat("/other/responses")).toBeNull();
    expect(identifyApiFormat("/groupish/responses", "/group")).toBeNull();
  });

  test("malformed, missing, empty and non-string models are identified", () => {
    for (const payload of [null, [], {}, { model: 123 }, { model: " " }]) {
      expect(inspectModelRequest(body(payload), "POST", "/responses")).toMatchObject({
        model: null,
        requiresModel: true,
      });
    }
    expect(inspectModelRequest(Buffer.from("{"), "POST", "/responses").invalidJson).toBe(true);
    expect(inspectModelRequest(Buffer.alloc(0), "GET", "/v1/models").requiresModel).toBe(false);
    expect(inspectModelRequest(body({ hello: true }), "POST", "/generic").requiresModel).toBe(
      false,
    );
    expect(inspectModelRequest(body({ model: "local" }), "POST", "/generic").requiresModel).toBe(
      true,
    );
  });

  test("unmapped bytes and attempt bodies are isolated", () => {
    const original = Buffer.from('{ "model": "local", "messages": [], "stream": true }');
    expect(rewriteRequestModel(original, "local")).toBe(original);
    expect(JSON.parse(rewriteRequestModel(original, "first").toString()).model).toBe("first");
    expect(JSON.parse(rewriteRequestModel(original, "second").toString())).toEqual({
      model: "second",
      messages: [],
      stream: true,
    });
    expect(original.toString()).toBe('{ "model": "local", "messages": [], "stream": true }');
    expect(() => rewriteRequestModel(body([]), "bad")).toThrow();
  });
});

describe("configuration and viewer drafts", () => {
  test("model entries survive JSON round-trip, extraction and form round-trip", () => {
    const forward = proxyForwardSchema.parse({
      name: "group",
      target: "https://example.com",
      modelRouting: routing,
    });
    const parsed = parseConfigFile(
      serializeConfigFile({
        instances: [
          {
            name: "test",
            port: 12345,
            enabled: true,
            description: null,
            headers: null,
            forwards: [forward],
          },
        ],
      }),
    ).instances[0]!.forwards[0]!;
    expect(getProviderRoutingConfig(parsed)).toEqual({ modelRouting: routing });
    expect(parseModelRoutingDraft(createModelRoutingDraft(parsed.modelRouting))).toEqual(routing);
  });

  test("empty draft and equivalent API order have stable fingerprints", () => {
    expect(parseModelRoutingDraft(createModelRoutingDraft())).toBeNull();
    expect(modelRoutingFingerprint(undefined)).toBe(
      modelRoutingFingerprint({ mode: "all", models: [] }),
    );
    expect(
      modelRoutingFingerprint({
        mode: "all",
        models: [{ name: "one", apiFormats: ["responses", "anthropic-messages"] }],
      }),
    ).toBe(
      modelRoutingFingerprint({
        mode: "all",
        models: [{ name: "one", apiFormats: ["anthropic-messages", "responses", "responses"] }],
      }),
    );
  });

  test("aliases split on commas and newlines; incomplete/duplicate rows stay invalid", () => {
    const draft = createModelRoutingDraft(routing);
    draft.models[0]!.aliases = " local, extra，another\nlast ";
    expect(parseModelRoutingDraft(draft)?.models[0]!.aliases).toEqual([
      "local",
      "extra",
      "another",
      "last",
    ]);
    draft.models[0]!.name = "";
    expect(() => parseModelRoutingDraft(draft)).toThrow();
    draft.models[0]!.name = draft.models[1]!.name;
    expect(() => parseModelRoutingDraft(draft)).toThrow("重复");
  });

  test("drafts and expected snapshot do not mutate saved configuration", () => {
    const initial = JSON.stringify(routing);
    const session = createModelRoutingSession(routing);
    session.draft.models[0]!.name = "changed";
    session.draft.models[0]!.apiFormats.push("anthropic-messages");
    session.expected!.models[0]!.aliases!.push("another");
    expect(JSON.stringify(routing)).toBe(initial);
  });

  test("per-ID drafts survive unsubscribe/collapse and reorder without cross-card updates", () => {
    const store = createModelRoutingDraftStore();
    const first = JSON.stringify(["instance", "id-1"]);
    const second = JSON.stringify(["instance", "id-2"]);
    let firstUpdates = 0;
    let secondUpdates = 0;
    const unsubscribe = store.subscribe(first, () => firstUpdates++);
    store.subscribe(second, () => secondUpdates++);
    const session = createModelRoutingSession(routing);
    store.set(first, session);
    expect(firstUpdates).toBe(1);
    expect(secondUpdates).toBe(0);
    unsubscribe();
    expect(store.get(first)).toBe(session);
    store.set(second, createModelRoutingSession());
    store.subscribe(first, () => firstUpdates++);
    expect(store.get(first)).toBe(session);
    store.set(first, { ...session, error: "network failure" });
    expect(firstUpdates).toBe(2);
    expect(secondUpdates).toBe(1);
    expect(store.get(second)?.draft.models).toEqual([]);
    store.set(first, undefined);
    expect(store.get(first)).toBeUndefined();
  });
});
