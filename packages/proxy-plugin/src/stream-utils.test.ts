import { expect, test } from "bun:test";
import { readStreamToBuffer, streamFromBuffer } from "./stream-utils";

test("readStreamToBuffer releases its reader lock", async () => {
  const stream = streamFromBuffer(Buffer.from("request body", "utf-8"));

  expect((await readStreamToBuffer(stream)).toString("utf-8")).toBe("request body");
  expect(stream.locked).toBe(false);
});
