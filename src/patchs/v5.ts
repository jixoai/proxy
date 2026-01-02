import type { Database } from "bun:sqlite";

export async function applyPatchV5(db: Database) {
  const cols = db.query("PRAGMA table_info(proxy_requests)").all() as Array<{ name: string }>;
  const hasListSummary = cols.some((c) => c.name === "list_summary");
  if (hasListSummary) return;

  db.exec("ALTER TABLE proxy_requests ADD COLUMN list_summary TEXT");
}
