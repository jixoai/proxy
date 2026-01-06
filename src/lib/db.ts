import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { clearDataDir, getDataDir, getDbPath, ensureDataDir } from "./runtime-paths";
import { createSchemaV7, SCHEMA_VERSION, needsMigrationToV7, migrateToV7 } from "./db-schema-v7";

// 延迟初始化数据库实例
// 必须在 setDataDir() 调用之后才能访问
let _db: Database | null = null;

/**
 * 获取数据库实例
 * 必须在 initDatabase() 调用之后才能使用
 */
export function getDb(): Database {
  if (!_db) {
    throw new Error(
      "Database not initialized. Call initDatabase() first after setting data directory.",
    );
  }
  return _db;
}

// 为了兼容现有代码，使用 getter 导出 db
// 注意：实际数据库实例在 initDatabase() 后才可用
export const db = {
  get instance(): Database {
    return getDb();
  },
  query(sql: string) {
    return getDb().query(sql);
  },
  run(sql: string, ...params: any[]) {
    return getDb().run(sql, ...params);
  },
  exec(sql: string) {
    return getDb().exec(sql);
  },
  prepare(sql: string) {
    return getDb().prepare(sql);
  },
};

export class DatabaseSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSchemaError";
  }
}

async function promptMigrationDecision(params: {
  fromVersion: number;
  toVersion: number;
}): Promise<"upgrade" | "clear" | "abort"> {
  const { fromVersion, toVersion } = params;
  const mode = (process.env.JIXO_DB_MIGRATION ?? "prompt").toLowerCase();

  if (mode === "auto") return "upgrade";
  if (mode === "abort") return "abort";
  if (mode === "clear") return "clear";

  const looksLikeTest =
    process.argv.includes("test") ||
    process.argv.some((arg) => arg.endsWith(".test.ts") || arg.endsWith(".test.tsx"));
  if (looksLikeTest) return "upgrade";

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) {
    // 无交互输入时，默认自动升级，避免启动卡住。
    return "upgrade";
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      `\n[Database] Detected older schema v${fromVersion} (expected v${toVersion}).\n` +
        `- Upgrade: apply DB patches and migrate data (may take time).\n` +
        `- Clear: delete ALL local DB data under ${getDataDir()} (irreversible).\n`,
    );

    while (true) {
      const answer = (await rl.question("Choose: [u]pgrade / [c]lear / [a]bort (default u): "))
        .trim()
        .toLowerCase();

      if (answer === "" || answer === "u" || answer === "upgrade") return "upgrade";
      if (answer === "a" || answer === "abort") return "abort";
      if (answer === "c" || answer === "clear") {
        const confirm = (await rl.question("Confirm clear? [y/N]: "))
          .trim()
          .toLowerCase();
        if (confirm === "y" || confirm === "yes") return "clear";
        console.log("[Database] Clear cancelled.");
        continue;
      }
    }
  } finally {
    rl.close();
  }
}

export async function initDatabase() {
  // 如果已经初始化，跳过
  if (_db) {
    return;
  }

  // 在这里才真正创建数据库，确保 setDataDir() 已经被调用
  const DB_PATH = getDbPath();

  ensureDataDir();
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH, { create: true });

  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA synchronous = NORMAL");
  _db.run("PRAGMA busy_timeout = 5000");

  // 创建 schema_meta 表（如果不存在）
  _db.run(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // 检查是否需要迁移到 v7
  if (needsMigrationToV7(_db)) {
    // 检查是否有旧数据
    const versionRow = _db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
      value: string;
    } | null;
    const dbVersion = versionRow ? parseInt(versionRow.value, 10) : 0;
    
    if (dbVersion > 0 && dbVersion < SCHEMA_VERSION) {
      // 有旧数据，提示用户
      const decision = await promptMigrationDecision({
        fromVersion: dbVersion,
        toVersion: SCHEMA_VERSION,
      });

      if (decision === "abort") {
        throw new DatabaseSchemaError(
          `Database schema version mismatch: expected ${SCHEMA_VERSION}, found ${dbVersion}. ` +
            `v7 is a breaking change that requires data reset.`,
        );
      }

      if (decision === "clear") {
        try {
          _db?.close();
        } catch {
          // ignore
        }
        _db = null;
        clearDataDir();
        await initDatabase();
        return;
      }
      
      // decision === "upgrade" => 破坏性迁移
    }
    
    // 执行迁移（新数据库或破坏性升级）
    migrateToV7(_db);
  }

  console.log("[Database] Schema version", SCHEMA_VERSION, "OK");
}
