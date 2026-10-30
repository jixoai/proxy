type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_PREFIX = "proxy:collapsed-forward-groups:";

export function readCollapsedForwardGroups(
  instanceName: string,
  storage?: PreferenceStorage,
): Set<string> {
  try {
    const value = (storage ?? window.localStorage).getItem(`${STORAGE_PREFIX}${instanceName}`);
    const parsed: unknown = JSON.parse(value ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((name): name is string => typeof name === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedForwardGroups(
  instanceName: string,
  groups: ReadonlySet<string>,
  storage?: PreferenceStorage,
): void {
  try {
    (storage ?? window.localStorage).setItem(
      `${STORAGE_PREFIX}${instanceName}`,
      JSON.stringify([...groups]),
    );
  } catch {}
}
