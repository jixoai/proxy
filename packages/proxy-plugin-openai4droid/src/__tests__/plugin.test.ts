import { describe, expect, it } from "bun:test";
import { createDroidPlugin } from "../plugin";

describe("createDroidPlugin.shouldProcessResponse", () => {
  const plugin = createDroidPlugin();
  const shouldProcessResponse = plugin.shouldProcessResponse!;

  const requestMeta = {
    method: "POST",
    url: "http://example.com/openai-droid/responses",
    headers: { "content-type": "application/json" },
  };

  it("processes gateway error responses even without content-type", () => {
    const result = shouldProcessResponse(
      {
        statusCode: 502,
        headers: {},
      },
      requestMeta,
    );

    expect(result).toBe(true);
  });

  it("skips non-json and non-sse success responses", () => {
    const result = shouldProcessResponse(
      {
        statusCode: 200,
        headers: { "content-type": "text/plain" },
      },
      requestMeta,
    );

    expect(result).toBe(false);
  });
});
