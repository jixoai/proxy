import { describe, expect, it } from "bun:test";
import { getHookConfigSummaries } from "../src/lib/hooks-config";

describe("hooks-config summaries", () => {
  it("shows fixed model for model-rewrite hook", () => {
    const summaries = getHookConfigSummaries({
      type: "http",
      command: "bunx",
      args: ["@jixo/proxy-plugin-model-rewrite"],
      config: {
        model: "gpt-5.2",
      },
    });

    expect(summaries).toEqual([{ label: "Model gpt-5.2" }]);
  });

  it("shows rule count and tooltip for mapped model config", () => {
    const summaries = getHookConfigSummaries({
      type: "http",
      command: "bunx",
      args: ["@jixo/proxy-plugin-model-rewrite"],
      config: {
        model: {
          "gpt-4o-mini": "gpt-5.4-mini",
          "*": "gpt-5.4",
        },
      },
    });

    expect(summaries).toEqual([
      {
        label: "Model 2 条规则",
        tooltip: "gpt-4o-mini -> gpt-5.4-mini\n* -> gpt-5.4",
      },
    ]);
  });

  it("ignores non model-rewrite hooks", () => {
    const summaries = getHookConfigSummaries({
      type: "http",
      command: "bunx",
      args: ["@jixo/proxy-plugin-codex"],
      config: {
        model: "gpt-5.2",
      },
    });

    expect(summaries).toEqual([]);
  });
});
