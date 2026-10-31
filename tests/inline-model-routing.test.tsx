import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineModelRouting } from "../src/components/ProxyControl/InlineModelRouting";
import { ModelRoutingDraftProvider } from "../src/components/ProxyControl/ModelRoutingDraftProvider";
import { proxyForwardSchema } from "../src/lib/config-schema";
import type { ModelRouting } from "../src/types/proxy";

function renderRouting(modelRouting?: ModelRouting | null) {
  const forward = proxyForwardSchema.parse({
    id: "provider",
    name: "glm",
    target: "https://provider.example",
    modelRouting,
  });
  return renderToStaticMarkup(
    <ModelRoutingDraftProvider>
      <InlineModelRouting forward={forward} instanceName="instance" onUpdate={() => {}} />
    </ModelRoutingDraftProvider>,
  );
}

test("model details are collapsed by default; summary hides APIs, aliases and edit controls", () => {
  const markup = renderRouting({
    mode: "all",
    models: [{ name: "upstream-model", aliases: ["local-alias"], apiFormats: ["responses"] }],
  });
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain('aria-controls="');
  expect(markup).toContain('hidden=""');
  expect(markup).toContain("upstream-model");
  expect(markup).toContain("全部支持");
  for (const content of [
    "local-alias",
    "Responses",
    "支持的 API",
    "添加模型",
    "data-model-row",
    "<input",
    "<select",
  ])
    expect(markup).not.toContain(content);
});

test("empty defaults still advertise all models without requiring a configuration", () => {
  const markup = renderRouting();
  expect(markup).toContain("全部模型（默认）");
  expect(markup).toContain("展开模型配置 glm");
  expect(markup).not.toContain("仅表内");
});

test("listed mode and long model lists keep their scope and compact summary", () => {
  const markup = renderRouting({
    mode: "listed",
    models: Array.from({ length: 8 }, (_, index) => ({ name: `glm-${index}` })),
  });
  expect(markup).toContain("仅表内");
  expect(markup).toContain("glm-0、glm-1、glm-2 等 8 个");
  expect(markup).not.toContain("全部支持");
  expect(markup).not.toContain("data-model-row");
});
