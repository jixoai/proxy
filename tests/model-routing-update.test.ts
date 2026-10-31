import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { ProxyConfigStore } from "../src/lib/store/proxy-config-store";
import { ModelRoutingUpdateError } from "../src/lib/model-routing-update";
import type { ModelRouting } from "../src/types/proxy";

let directory: string;
let store: ProxyConfigStore;
const routing: ModelRouting = {
  mode: "all",
  models: [{ name: "glm-5.3", aliases: ["local"], apiFormats: ["responses"] }],
};

beforeEach(() => {
  directory = mkdtempSync(path.join(import.meta.dirname, ".model-update-"));
  const filePath = path.join(directory, "config.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      instances: [
        {
          name: "instance",
          port: 20002,
          enabled: false,
          headers: { shared: "keep" },
          forwards: [
            {
              id: "first",
              name: "group",
              target: "https://first.example",
              enabled: false,
              headers: { custom: "keep" },
              hooks: [],
              timeout: 15,
            },
            { id: "second", name: "group", target: "https://second.example" },
          ],
        },
      ],
    }),
  );
  store = new ProxyConfigStore({ filePath, enableWatch: false });
});
afterEach(() => {
  store.destroy();
  rmSync(directory, { recursive: true, force: true });
});

test("targeted model update preserves all other config and notifies once", () => {
  const original = store.getData();
  let changes = 0;
  let forwards = 0;
  store.on("change", () => changes++);
  store.on("forward-change", () => forwards++);
  const saved = store.updateModelRouting("instance", "first", {
    expected: null,
    modelRouting: routing,
  });
  const expected = structuredClone(original);
  expected.instances[0]!.forwards[0]!.modelRouting = routing;
  expect(store.getData()).toEqual(expected);
  expect(saved.id).toBe("first");
  expect(changes).toBe(1);
  expect(forwards).toBe(1);
  expect(
    JSON.parse(readFileSync(path.join(directory, "config.json"), "utf8")).instances[0].forwards[0]
      .modelRouting,
  ).toEqual(routing);
});

test("ID targeting survives reorder, rename, disabled state and latest unrelated edits", () => {
  const instance = store.getInstanceByName("instance")!;
  instance.forwards.reverse();
  instance.forwards[1] = {
    ...instance.forwards[1]!,
    name: "renamed",
    target: "https://new.example",
    timeout: 30,
  };
  store.upsertInstance(instance);
  store.updateModelRouting("instance", "first", { expected: null, modelRouting: routing });
  expect(store.getData().instances[0]!.forwards.map((forward) => forward.id)).toEqual([
    "second",
    "first",
  ]);
  expect(store.getData().instances[0]!.forwards[1]).toMatchObject({
    name: "renamed",
    target: "https://new.example",
    enabled: false,
    timeout: 30,
    modelRouting: routing,
  });
  expect(store.getData().instances[0]!.forwards[0]!.modelRouting).toBeNull();
});

test("simultaneous drafts compare-and-swap, losing draft does not mutate config or file", async () => {
  const results = await Promise.allSettled([
    Promise.resolve().then(() =>
      store.updateModelRouting("instance", "first", { expected: null, modelRouting: routing }),
    ),
    Promise.resolve().then(() =>
      store.updateModelRouting("instance", "first", {
        expected: null,
        modelRouting: { mode: "listed", models: [{ name: "other" }] },
      }),
    ),
  ]);
  expect(results[0]!.status).toBe("fulfilled");
  expect(results[1]!.status).toBe("rejected");
  if (results[1]!.status === "rejected") expect(results[1]!.reason).toMatchObject({ status: 409 });
  const original = readFileSync(path.join(directory, "config.json"), "utf8");
  expect(() =>
    store.updateModelRouting("instance", "first", { expected: null, modelRouting: null }),
  ).toThrow(ModelRoutingUpdateError);
  expect(readFileSync(path.join(directory, "config.json"), "utf8")).toBe(original);
  expect(store.getData().instances[0]!.forwards[0]!.modelRouting).toEqual(routing);
});

test("missing IDs return 404 and invalid/listed-empty payloads do not write", () => {
  for (const [instanceName, forwardId] of [
    ["missing", "first"],
    ["instance", "deleted"],
  ]) {
    try {
      store.updateModelRouting(instanceName!, forwardId!, {
        expected: null,
        modelRouting: routing,
      });
      throw new Error("must reject");
    } catch (error) {
      expect(error).toMatchObject({ status: 404 });
    }
  }
  const initial = store.getData();
  for (const input of [
    { modelRouting: routing },
    { expected: null, modelRouting: { mode: "listed", models: [] } },
    { expected: null, modelRouting: null, target: "https://wrong.example" },
  ]) {
    expect(() => store.updateModelRouting("instance", "first", input)).toThrow();
  }
  expect(store.getData()).toEqual(initial);
});

test("base-config patches preserve newer model config, enabled state and omitted fields", () => {
  store.updateModelRouting("instance", "first", { expected: null, modelRouting: routing });
  const original = store.getData().instances[0]!.forwards[0]!;
  const updated = store.updateForwardBasics("instance", "first", { description: "changed" });
  expect(updated).toEqual({ ...original, description: "changed" });
  expect(() => store.updateForwardBasics("instance", "first", { modelRouting: null })).toThrow();
  expect(() => store.updateForwardBasics("instance", "first", { id: "second" })).toThrow();
  expect(() => store.updateForwardBasics("instance", "first", { enabled: true })).toThrow();
  expect(() => store.updateForwardBasics("instance", "missing", { name: "new" })).toThrow(
    ModelRoutingUpdateError,
  );
});

test("full config legacy declaration is rejected before any save", () => {
  const initial = store.getData();
  const instance = structuredClone(initial.instances[0]!);
  Object.assign(instance.forwards[0]!, { apiFormats: ["responses"] });
  expect(() => store.upsertInstance(instance)).toThrow();
  expect(store.getData()).toEqual(initial);
});
