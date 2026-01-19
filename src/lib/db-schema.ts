/**
 * Database Schema - 分表架构
 * 
 * 设计目标：
 * 1. 列表查询极快：requests 表只存元数据，不存 body
 * 2. 增量写入 body：流式时可以直接追加，不用读-改-写
 * 3. 按需加载：详情页才查 bodies 表
 * 4. Layer body 有处存：每层 hook 的 body 有独立记录
 */

import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 10;

/**
 * Body 阶段类型
 */
export type BodyStage =
  | "request_origin"      // 原始请求体
  | "request_hooked"      // hook 后请求体
  | "response_origin"     // 原始响应体
  | "response_hooked"     // hook 后响应体
  | `request_layer_${number}`   // 请求 hook 第 N 层
  | `response_layer_${number}`; // 响应 hook 第 N 层

export function createSchema(db: Database): void {
  db.exec(`
    -- 主表：轻量元数据，用于列表查询
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      instance_name TEXT,
      forward_name TEXT,
      forward_id TEXT,
      
      -- 请求基础信息
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      target_url TEXT,
      hooked_method TEXT,
      hooked_url TEXT,
      url_lc TEXT,
      path_lc TEXT,
      
      -- 状态
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      abort_reason TEXT,
      client_aborted INTEGER DEFAULT 0,
      
      -- 响应信息（可选，streaming 时逐步填充）
      status_code INTEGER,
      status_message TEXT,
      content_type TEXT,
      
      -- 时间指标
      ttfb_ms INTEGER,
      body_ms INTEGER,
      
      -- Body 大小（用于列表显示，不存实际内容）
      request_body_size INTEGER DEFAULT 0,
      response_body_size INTEGER DEFAULT 0,
      
      -- 是否有 hook 变更
      has_request_hook_changes INTEGER DEFAULT 0,
      has_response_hook_changes INTEGER DEFAULT 0,
      
      -- WebSocket 相关
      is_websocket INTEGER DEFAULT 0,
      websocket_direction TEXT,
      
      -- 插件信息（JSON，用于列表显示）
      plugin_info TEXT
    );

    -- Headers 表：存储各阶段的 headers
    CREATE TABLE IF NOT EXISTS request_headers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      headers TEXT NOT NULL,
      UNIQUE(request_id, stage)
    );

    -- Bodies 表：存储各阶段的 body（BLOB 直接存二进制）
    CREATE TABLE IF NOT EXISTS request_bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      content_type TEXT,
      body BLOB,
      body_size INTEGER DEFAULT 0,
      UNIQUE(request_id, stage)
    );

    -- Hook Layers 表：存储每层 hook 的元数据
    CREATE TABLE IF NOT EXISTS hook_layers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      layer_index INTEGER NOT NULL,
      plugin_name TEXT NOT NULL,
      modified INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      status_message TEXT,
      UNIQUE(request_id, direction, layer_index)
    );

    -- 索引：主表查询优化
    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_instance ON requests(instance_name);
    CREATE INDEX IF NOT EXISTS idx_requests_forward ON requests(forward_name);
    CREATE INDEX IF NOT EXISTS idx_requests_method ON requests(method);
    CREATE INDEX IF NOT EXISTS idx_requests_status_code ON requests(status_code);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_url_lc ON requests(url_lc);
    CREATE INDEX IF NOT EXISTS idx_requests_path_lc ON requests(path_lc);

    -- 索引：关联表外键
    CREATE INDEX IF NOT EXISTS idx_request_headers_request_id ON request_headers(request_id);
    CREATE INDEX IF NOT EXISTS idx_request_bodies_request_id ON request_bodies(request_id);
    CREATE INDEX IF NOT EXISTS idx_hook_layers_request_id ON hook_layers(request_id);

    -- FTS5 表：用于模糊搜索
    CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(
      url,
      path,
      content='requests',
      content_rowid='id',
      tokenize='unicode61'
    );

    -- FTS 触发器：自动同步
    CREATE TRIGGER IF NOT EXISTS requests_fts_insert AFTER INSERT ON requests BEGIN
      INSERT INTO requests_fts(rowid, url, path) VALUES (new.id, new.url_lc, new.path_lc);
    END;

    CREATE TRIGGER IF NOT EXISTS requests_fts_delete AFTER DELETE ON requests BEGIN
      INSERT INTO requests_fts(requests_fts, rowid, url, path) VALUES ('delete', old.id, old.url_lc, old.path_lc);
    END;

    CREATE TRIGGER IF NOT EXISTS requests_fts_update AFTER UPDATE ON requests BEGIN
      INSERT INTO requests_fts(requests_fts, rowid, url, path) VALUES ('delete', old.id, old.url_lc, old.path_lc);
      INSERT INTO requests_fts(rowid, url, path) VALUES (new.id, new.url_lc, new.path_lc);
    END;
  `);
}

export function needsMigration(db: Database): boolean {
  const row = db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | null;
  if (!row) return true;
  const version = parseInt(row.value, 10);
  return version < SCHEMA_VERSION;
}

export function migrateToLatest(db: Database): void {
  console.log(`[Database] Migrating to schema v${SCHEMA_VERSION} (destructive)...`);
  
  // 删除旧表
  db.exec(`
    DROP TABLE IF EXISTS proxy_requests_fts;
    DROP TABLE IF EXISTS proxy_requests;
    DROP TABLE IF EXISTS requests_fts;
    DROP TABLE IF EXISTS hook_layers;
    DROP TABLE IF EXISTS request_bodies;
    DROP TABLE IF EXISTS request_headers;
    DROP TABLE IF EXISTS requests;
  `);
  
  // 创建新 schema
  createSchema(db);
  
  // 更新版本号
  db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)", [String(SCHEMA_VERSION)]);
  
  console.log("[Database] Migration to v10 complete");
}
