import { describe, expect, test } from "bun:test";
import {
  readCollapsedForwardGroups,
  writeCollapsedForwardGroups,
} from "../src/lib/forward-group-preferences";

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("forward group presentation preferences", () => {
  test("new instances have every group expanded by default", () => {
    expect(readCollapsedForwardGroups("new", createStorage()).size).toBe(0);
  });

  test("remembers exact group names and removes duplicate entries", () => {
    const storage = createStorage();
    const collapsed = new Set(["不常用 / 备用", "__proto__", "constructor", "常用"]);
    writeCollapsedForwardGroups("实例 / primary", collapsed, storage);
    expect(readCollapsedForwardGroups("实例 / primary", storage)).toEqual(collapsed);
    expect(collapsed.size).toBe(4);
  });

  test("isolates identical group names between instances", () => {
    const storage = createStorage();
    writeCollapsedForwardGroups("primary", new Set(["备用"]), storage);
    writeCollapsedForwardGroups("other", new Set(["常用"]), storage);
    expect([...readCollapsedForwardGroups("primary", storage)]).toEqual(["备用"]);
    expect([...readCollapsedForwardGroups("other", storage)]).toEqual(["常用"]);
    expect(storage.values.size).toBe(2);
  });

  test("writes an empty preference when all groups are expanded", () => {
    const storage = createStorage();
    writeCollapsedForwardGroups("primary", new Set(["备用"]), storage);
    writeCollapsedForwardGroups("primary", new Set(), storage);
    expect(readCollapsedForwardGroups("primary", storage).size).toBe(0);
  });

  test("ignores invalid JSON and values that are not arrays", () => {
    for (const value of ["{broken", "null", "true", "42", '"group"', '{"group":true}']) {
      const storage = { getItem: () => value, setItem: () => {} };
      expect(readCollapsedForwardGroups("primary", storage).size).toBe(0);
    }
  });

  test("discards non-string entries in saved preferences", () => {
    const storage = { getItem: () => '["备用",12,null,{},"备用","常用"]', setItem: () => {} };
    expect([...readCollapsedForwardGroups("primary", storage)]).toEqual(["备用", "常用"]);
  });

  test("unavailable storage does not prevent toggling session state", () => {
    const storage = {
      getItem: (): string | null => {
        throw new Error("storage denied");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    const collapsed = readCollapsedForwardGroups("primary", storage);
    collapsed.add("备用");
    expect(() => writeCollapsedForwardGroups("primary", collapsed, storage)).not.toThrow();
    expect(collapsed.has("备用")).toBe(true);
  });

  test("returns independent sets so changing one instance cannot mutate another", () => {
    const storage = createStorage();
    const first = readCollapsedForwardGroups("primary", storage);
    const other = readCollapsedForwardGroups("other", storage);
    first.add("备用");
    expect(other.size).toBe(0);
    expect(storage.values.size).toBe(0);
  });
});
