import type { Database } from "bun:sqlite";

export async function applyPatchV6(db: Database) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS proxy_requests_fts
    USING fts5(
      url,
      path,
      tokenize='unicode61'
    );
  `);

  try {
    db.exec("BEGIN");
    db.exec("DELETE FROM proxy_requests_fts");
    db.exec(`
      INSERT INTO proxy_requests_fts(rowid, url, path)
      SELECT id, COALESCE(request_url_lc, ''), COALESCE(request_path_lc, '')
      FROM proxy_requests
      ORDER BY id ASC
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }
}
