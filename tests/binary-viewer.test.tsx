import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { cloneElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BinaryViewerPanel } from "../src/plugins/binaryViewerPlugin";

test.each([0, 1, 2, 3, 256, 32767, 32768, 32769, 65536, 1048577])(
  "binary viewer encodes %i bytes as Base64 without overflowing the stack",
  (length) => {
    const data = Uint8Array.from({ length }, (_, index) => index % 256);
    const panel = BinaryViewerPanel({ data });
    const markup = renderToStaticMarkup(cloneElement(panel, { defaultValue: "base64" }));

    expect(markup).toContain(
      `<pre class="font-mono text-xs break-all whitespace-pre-wrap">${Buffer.from(data).toString("base64")}</pre>`,
    );
  },
);

test("binary viewer only encodes bytes inside a subarray", () => {
  const data = Uint8Array.from({ length: 65540 }, (_, index) => index % 256).subarray(1, 65538);
  const panel = BinaryViewerPanel({ data });
  const markup = renderToStaticMarkup(cloneElement(panel, { defaultValue: "base64" }));

  expect(markup).toContain(Buffer.from(data).toString("base64"));
});

test("binary viewer renders large bodies in the default UTF-8 tab", () => {
  const data = new Uint8Array(1024 * 1024).fill(65);
  const markup = renderToStaticMarkup(<BinaryViewerPanel data={data} />);

  expect(markup).toContain("UTF-8");
  expect(markup).toContain("A".repeat(data.length));
});
