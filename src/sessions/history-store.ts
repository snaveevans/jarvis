import { mkdirSync } from 'node:fs'
import path from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'

import type { ChatMessage } from '../llm/types.ts'

const CURRENT_SCHEMA_VERSION = 1

export interface SessionHistoryConfig {
  dbPath: string
}

export interface SessionHistoryMessage {
  seq: number
  role: Extract<ChatMessage['role'], 'user' | 'assistant'>
  content: string
  createdAt: string
}

export type EvictionBatchStatus = 'pending' | 'processed' | 'failed'

export interface SessionHistoryStore {
  appendMessage(
    sessionId: string,
    endpointKind: string,
    seq: number,
    role: Extract<ChatMessage['role'], 'user' | 'assistant'>,
    content: string
  ): void
  loadRecentMessages(sessionId: string, limit: number): SessionHistoryMessage[]
  clearSession(sessionId: string): void
  createEvictionBatch(sessionId: string, startSeq: number, endSeq: number): number
  markBatchStatus(batchId: number, status: EvictionBatchStatus): void
  purgeProcessedMessagesOlderThan(retentionHours: number): number
  close(): void
}

function ensureSchema(db: SqliteDatabase): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      session_id        TEXT NOT NULL,
      endpoint_kind     TEXT NOT NULL,
      seq               INTEGER NOT NULL,
      role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content           TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      evicted_batch_id  INTEGER,
      PRIMARY KEY (session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS eviction_batches (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        TEXT NOT NULL,
      start_seq         INTEGER NOT NULL,
      end_seq           INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      evaluator_ran_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_messages_session_seq
      ON session_messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_session_messages_batch
      ON session_messages(evicted_batch_id);
    CREATE INDEX IF NOT EXISTS idx_session_messages_created
      ON session_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_eviction_batches_status_created
      ON eviction_batches(status, created_at);
  `)

  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
}

export function createSessionHistoryStore(config: SessionHistoryConfig): SessionHistoryStore {
  mkdirSync(path.dirname(config.dbPath), { recursive: true })
  const db = new BetterSqlite3(config.dbPath)
  db.pragma('journal_mode = WAL')
  ensureSchema(db)

  const insertMessageStmt = db.prepare(`
    INSERT OR IGNORE INTO session_messages (session_id, endpoint_kind, seq, role, content)
    VALUES (?, ?, ?, ?, ?)
  `)
  const loadRecentStmt = db.prepare(`
    SELECT seq, role, content, created_at
    FROM session_messages
    WHERE session_id = ?
    ORDER BY seq DESC
    LIMIT ?
  `)
  const clearMessagesStmt = db.prepare(`
    DELETE FROM session_messages
    WHERE session_id = ?
  `)
  const clearBatchesStmt = db.prepare(`
    DELETE FROM eviction_batches
    WHERE session_id = ?
  `)
  const insertBatchStmt = db.prepare(`
    INSERT INTO eviction_batches (session_id, start_seq, end_seq, status)
    VALUES (?, ?, ?, 'pending')
  `)
  const markMessagesBatchStmt = db.prepare(`
    UPDATE session_messages
    SET evicted_batch_id = ?
    WHERE session_id = ?
      AND seq >= ?
      AND seq <= ?
      AND evicted_batch_id IS NULL
  `)
  const markBatchStatusStmt = db.prepare(`
    UPDATE eviction_batches
    SET status = ?, evaluator_ran_at = datetime('now')
    WHERE id = ?
  `)
  const purgeMessagesStmt = db.prepare(`
    DELETE FROM session_messages
    WHERE evicted_batch_id IN (
      SELECT id
      FROM eviction_batches
      WHERE status = 'processed'
        AND datetime(created_at) <= datetime(?)
    )
      AND datetime(created_at) <= datetime(?)
  `)
  const purgeBatchesStmt = db.prepare(`
    DELETE FROM eviction_batches
    WHERE status = 'processed'
      AND datetime(created_at) <= datetime(?)
      AND id NOT IN (
        SELECT DISTINCT evicted_batch_id
        FROM session_messages
        WHERE evicted_batch_id IS NOT NULL
      )
  `)

  return {
    appendMessage(sessionId, endpointKind, seq, role, content): void {
      insertMessageStmt.run(sessionId, endpointKind, seq, role, content)
    },

    loadRecentMessages(sessionId, limit): SessionHistoryMessage[] {
      const rows = loadRecentStmt.all(sessionId, limit) as Array<{
        seq: number
        role: string
        content: string
        created_at: string
      }>
      return rows
        .map((row) => ({
          seq: row.seq,
          role: row.role as SessionHistoryMessage['role'],
          content: row.content,
          createdAt: row.created_at,
        }))
        .reverse()
    },

    clearSession(sessionId: string): void {
      const tx = db.transaction(() => {
        clearMessagesStmt.run(sessionId)
        clearBatchesStmt.run(sessionId)
      })
      tx()
    },

    createEvictionBatch(sessionId: string, startSeq: number, endSeq: number): number {
      const tx = db.transaction(() => {
        const result = insertBatchStmt.run(sessionId, startSeq, endSeq)
        const batchId = Number(result.lastInsertRowid)
        markMessagesBatchStmt.run(batchId, sessionId, startSeq, endSeq)
        return batchId
      })
      return tx()
    },

    markBatchStatus(batchId: number, status: EvictionBatchStatus): void {
      markBatchStatusStmt.run(status, batchId)
    },

    purgeProcessedMessagesOlderThan(retentionHours: number): number {
      const cutoff = retentionHours > 0
        ? `-${Math.floor(retentionHours)} hours`
        : 'now'

      const tx = db.transaction(() => {
        const deleted = purgeMessagesStmt.run(cutoff, cutoff).changes
        purgeBatchesStmt.run(cutoff)
        return deleted
      })
      return tx()
    },

    close(): void {
      db.close()
    },
  }
}
