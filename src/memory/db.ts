import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'

const CURRENT_SCHEMA_VERSION = 3

export interface MemoryDbHandle {
  db: SqliteDatabase
  dbPath: string
  close(): void
}

export function resolveMemoryDir(memoryDir?: string): string {
  if (typeof memoryDir === 'string' && memoryDir.trim().length > 0) {
    return memoryDir
  }
  return path.join(homedir(), '.jarvis')
}

function ensureSchema(db: SqliteDatabase): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      content        TEXT NOT NULL,
      type           TEXT NOT NULL CHECK (type IN ('preference', 'fact', 'conversation_summary')),
      tags           TEXT NOT NULL DEFAULT '[]',
      source         TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      token_count    INTEGER NOT NULL,
      archived_at    TEXT,
      archive_reason TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      tags,
      content=memories,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags)
      VALUES (new.id, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags)
      VALUES (new.id, new.content, new.tags);
    END;
  `)

  if (currentVersion < 2) {
    const columns = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>
    const existing = new Set(columns.map(column => column.name))
    if (!existing.has('archived_at')) {
      db.exec('ALTER TABLE memories ADD COLUMN archived_at TEXT')
    }
    if (!existing.has('archive_reason')) {
      db.exec('ALTER TABLE memories ADD COLUMN archive_reason TEXT')
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_archived_at ON memories(archived_at)')
  }

  if (currentVersion < 3) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_type_created
      ON memories(type, created_at DESC)
      WHERE archived_at IS NULL
    `)
  }

  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
}

export function createMemoryDb(memoryDir?: string): MemoryDbHandle {
  const resolvedDir = resolveMemoryDir(memoryDir)
  mkdirSync(resolvedDir, { recursive: true })

  const dbPath = path.join(resolvedDir, 'memory.db')
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')

  ensureSchema(db)

  return {
    db,
    dbPath,
    close: () => db.close(),
  }
}
