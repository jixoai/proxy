import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DB_PATH = path.join(__dirname, "../.tmp/proxy.db");
const envDbPath =
  process.env.PROXY_DB_PATH && process.env.PROXY_DB_PATH.length > 0
    ? path.resolve(process.env.PROXY_DB_PATH)
    : null;
const DB_PATH = envDbPath ?? DEFAULT_DB_PATH;

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA busy_timeout = 5000");

export function initDatabase() {
  // destructive migration: drop legacy tables
  db.run("DROP TABLE IF EXISTS proxy_requests_v2");
  db.run("DROP TABLE IF EXISTS proxy_requests");
  db.run("DROP TABLE IF EXISTS proxy_instances");
  db.run("DROP TABLE IF EXISTS proxy_forwards");

  db.run(`
    CREATE TABLE IF NOT EXISTS proxy_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      instance_name TEXT,
      forward_name TEXT,
      group_name TEXT,
      data TEXT NOT NULL
    )
  `);

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_proxy_requests_time ON proxy_requests(timestamp DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_proxy_requests_group ON proxy_requests(group_name)",
  );

  console.log("[Database] proxy_requests initialized");
}
