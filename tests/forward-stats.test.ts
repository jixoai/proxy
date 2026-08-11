/**
 * Intent (2026-08-12): prove locked same-name forward slots preserve the operator-selected index.
 * Original request: add a per-forward lock so automatic rotation skips its group position.
 */
import { describe, expect, test } from "bun:test";
import { applyLockedSlots, evaluateForwards, type ForwardMatcher } from "../src/lib/forward-stats";
import { parseConfigFile } from "../src/lib/config-schema";

function samples(success: boolean, count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: 1_000 + index,
    ttfbMs: 100,
    success,
  }));
}

describe("locked forward slots", () => {
  test("defaults the persisted lock state to unlocked", () => {
    const config = parseConfigFile(
      JSON.stringify({
        instances: [
          {
            name: "test",
            port: 29000,
            forwards: [{ name: "group", target: "https://example.com" }],
          },
        ],
      }),
    );

    expect(config.instances[0]?.forwards[0]?.orderLocked).toBe(false);
  });

  test("preserves a locked state through config parsing", () => {
    const config = parseConfigFile(
      JSON.stringify({
        instances: [
          {
            name: "test",
            port: 29000,
            forwards: [{ name: "group", target: "https://example.com", orderLocked: true }],
          },
        ],
      }),
    );

    expect(config.instances[0]?.forwards[0]?.orderLocked).toBe(true);
  });

  test("keeps a locked middle slot and fills the remaining slots by rank", () => {
    const forwards: ForwardMatcher[] = [
      { id: "a", index: 0 },
      { id: "b", index: 1, orderLocked: true },
      { id: "c", index: 2 },
    ];

    expect(applyLockedSlots(forwards, [2, 0, 1])).toEqual([2, 1, 0]);
  });

  test("applies locked slots inside health-based evaluation", () => {
    const forwards: ForwardMatcher[] = [
      { id: "a", index: 0 },
      { id: "b", index: 1, orderLocked: true },
      { id: "c", index: 2 },
    ];
    const samplesMap = new Map([
      ["a", samples(false)],
      ["b", samples(false)],
      ["c", samples(true)],
    ]);

    expect(evaluateForwards(forwards, samplesMap, 10_000, 100, 1_003).suggestedOrder).toEqual([
      2, 1, 0,
    ]);
  });

  test("keeps the existing result when no forward is locked", () => {
    const forwards: ForwardMatcher[] = [
      { id: "a", index: 0 },
      { id: "b", index: 1 },
    ];
    const samplesMap = new Map([
      ["a", samples(false)],
      ["b", samples(true)],
    ]);

    expect(evaluateForwards(forwards, samplesMap, 10_000, 100, 1_003).suggestedOrder).toEqual([
      1, 0,
    ]);
  });
});
