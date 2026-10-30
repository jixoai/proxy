import { describe, expect, test } from "bun:test";
import type { ProviderRoutingConfig } from "../src/types/proxy";
import { proxyForwardSchema, parseConfigFile, serializeConfigFile } from "../src/lib/config-schema";
import {
  getProviderRoutingConfig,
  providerRoutingSchema,
} from "../src/lib/provider-routing-config";
import {
  createProviderRoutingDraft,
  parseProviderRoutingDraft,
} from "../src/lib/provider-routing-form";
import {
  hasProviderRouting,
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

describe("provider capabilities", () => {
  test("omitted, null and empty configuration mean unrestricted", () => {
    for (const input of [
      {},
      { models: null, modelMapping: null, apiFormats: null, modelApiFormats: null },
      { models: [], modelMapping: {}, apiFormats: [], modelApiFormats: { local: [] } },
    ]) {
      const config = providerRoutingSchema.parse(input);
      expect(hasProviderRouting(config)).toBe(false);
      expect(resolveProviderModel(config, "local")).toBe("local");
      expect(providerIncompatibility(config, request, "local")).toBeNull();
    }
  });

  test("normalizes and deduplicates model names and capabilities", () => {
    expect(
      providerRoutingSchema.parse({
        models: [" glm-5.3 ", "glm-5.3"],
        modelMapping: { " local ": " glm-5.3 " },
        apiFormats: ["responses", "responses"],
        modelApiFormats: { " glm-5.3 ": ["responses", "responses"] },
      }),
    ).toEqual({
      models: ["glm-5.3"],
      modelMapping: { local: "glm-5.3" },
      apiFormats: ["responses"],
      modelApiFormats: { "glm-5.3": ["responses"] },
    });
  });

  test("rejects invalid declarations instead of silently accepting them", () => {
    for (const input of [
      { models: [""] },
      { apiFormats: ["unknown"] },
      { modelMapping: { local: "" } },
      { modelApiFormats: { local: ["bad"] } },
    ]) {
      expect(providerRoutingSchema.safeParse(input).success).toBe(false);
    }
  });

  test("mapping is independent of model whitelist, exact and case-sensitive", () => {
    const config = { modelMapping: { local: "glm-5.3", fast: "glm-5.3-flash" } };
    expect(resolveProviderModel(config, "local")).toBe("glm-5.3");
    expect(resolveProviderModel(config, "fast")).toBe("glm-5.3-flash");
    expect(resolveProviderModel(config, "Local")).toBe("Local");
    expect(resolveProviderModel(config, "unlisted")).toBe("unlisted");
    expect(providerIncompatibility(config, request, "unlisted")).toBeNull();
    expect(resolveProviderModel(config, "toString")).toBe("toString");
    expect(resolveProviderModel(config, null)).toBeNull();
  });

  test("checks target model, not client alias", () => {
    const config = { models: ["glm-5.3", "glm-5.3-flash"], modelMapping: { local: "glm-5.3" } };
    expect(
      providerIncompatibility(config, request, resolveProviderModel(config, request.model)),
    ).toBeNull();
    expect(providerIncompatibility(config, request, "local")).toBe("model_not_supported");
    expect(providerIncompatibility(config, request, "glm-5.3-flash")).toBeNull();
  });

  test("API restriction and model restriction intersect", () => {
    const config = providerRoutingSchema.parse({
      apiFormats: ["responses"],
      modelApiFormats: { local: ["anthropic-messages"] },
    });
    expect(providerIncompatibility(config, request, "local")).toBe("api_not_supported");
    expect(
      providerIncompatibility(config, { ...request, apiFormat: "anthropic-messages" }, "local"),
    ).toBe("api_not_supported");
    expect(providerIncompatibility(config, request, "other")).toBeNull();
    expect(providerIncompatibility(config, { ...request, apiFormat: null }, "local")).toBeNull();
  });

  test("model compatibility can be deferred for legacy hooks, but not provider API", () => {
    expect(providerIncompatibility({ models: ["target"] }, request, "local", true)).toBeNull();
    expect(
      providerIncompatibility({ apiFormats: ["anthropic-messages"] }, request, "local", true),
    ).toBe("api_not_supported");
  });

  test("missing model cannot bypass explicit whitelist", () => {
    expect(providerIncompatibility({ models: ["target"] }, { ...request, model: null }, null)).toBe(
      "missing_model",
    );
    expect(providerIncompatibility({}, { ...request, model: null }, null)).toBeNull();
  });

  test("only nonempty declarations require WebSocket guard", () => {
    for (const config of [
      { models: ["target"] },
      { modelMapping: { local: "target" } },
      { apiFormats: ["responses"] as const },
      { modelApiFormats: { local: ["responses"] as const } },
    ]) {
      expect(hasProviderRouting(providerRoutingSchema.parse(config))).toBe(true);
    }
  });
});

describe("request inspection and rewrite", () => {
  test("recognizes original API endpoints, prefixes and helper endpoints", () => {
    expect(identifyApiFormat("/group/v1/responses", "/group/")).toBe("responses");
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
      const result = inspectModelRequest(body(payload), "POST", "/responses");
      expect(result.model).toBeNull();
      expect(result.requiresModel).toBe(true);
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

  test("unmapped body remains byte-for-byte untouched and attempts do not share mutations", () => {
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
  test("capability fields survive JSON round-trip and runtime extraction", () => {
    const routing: ProviderRoutingConfig = {
      models: ["glm-5.3"],
      modelMapping: { local: "glm-5.3" },
      apiFormats: ["responses"],
      modelApiFormats: { "glm-5.3": ["responses"] },
    };
    const forward = proxyForwardSchema.parse({
      name: "group",
      target: "https://example.com",
      ...routing,
    });
    const serialized = serializeConfigFile({
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
    });
    const parsed = parseConfigFile(serialized).instances[0]!.forwards[0]!;
    expect(getProviderRoutingConfig(parsed)).toEqual(routing);
    expect(parseProviderRoutingDraft(createProviderRoutingDraft(parsed))).toEqual(routing);
  });

  test("empty draft restores unrestricted defaults", () => {
    const parsed = parseProviderRoutingDraft(createProviderRoutingDraft());
    expect(hasProviderRouting(parsed)).toBe(false);
    expect(JSON.stringify(parsed)).toBe("{}");
  });

  test("mapping-only draft does not create supported-model list", () => {
    const draft = createProviderRoutingDraft();
    draft.mappings.push({ from: " alias ", to: " target " });
    const config = parseProviderRoutingDraft(draft);
    expect(config.models).toBeUndefined();
    expect(config.modelMapping).toEqual({ alias: "target" });
  });

  test("incomplete and duplicate rows fail rather than silently overwriting", () => {
    const draft = createProviderRoutingDraft();
    draft.mappings = [{ from: "local", to: "" }];
    expect(() => parseProviderRoutingDraft(draft)).toThrow("同时填写");
    draft.mappings = [
      { from: "local", to: "one" },
      { from: " local ", to: "two" },
    ];
    expect(() => parseProviderRoutingDraft(draft)).toThrow("重复映射");
    draft.mappings = [];
    draft.modelApis = [{ model: "", formats: ["responses"] }];
    expect(() => parseProviderRoutingDraft(draft)).toThrow("目标模型名称");
    draft.modelApis = [
      { model: "local", formats: ["responses"] },
      { model: " local ", formats: [] },
    ];
    expect(() => parseProviderRoutingDraft(draft)).toThrow("重复配置");
  });

  test("editing drafts does not mutate input configuration", () => {
    const config = providerRoutingSchema.parse({
      models: ["local"],
      modelMapping: { local: "target" },
      apiFormats: ["responses"],
      modelApiFormats: { local: ["responses"] },
    });
    const initial = JSON.stringify(config);
    const draft = createProviderRoutingDraft(config);
    draft.models.push("another");
    draft.mappings[0]!.to = "changed";
    draft.apiFormats.push("anthropic-messages");
    draft.modelApis[0]!.formats.push("anthropic-messages");
    expect(JSON.stringify(config)).toBe(initial);
  });
});
