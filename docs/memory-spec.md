# Memory System Spec

Durable, queryable memory for Jarvis — without polluting context.

---

## Intent

Jarvis is stateless today. Every invocation starts from scratch. This makes it forget user preferences, past decisions, learned facts, and prior conversation context.

The memory system gives Jarvis **selective recall**: a persistent store of knowledge that it can search when relevant, without stuffing the entire history into every prompt. The goal is not "remember everything" — it's "remember what matters, retrieve only what's relevant."

---

## Design Principles

1. **Memory is a tool, not a system prompt** — Memories enter context through tool calls and bounded auto-injection, not by bloating the system message with everything ever stored.
2. **Bounded retrieval** — Auto-injected context is capped at ~500 tokens and ~5 results. The LLM can always search for more explicitly.
3. **Typed over free-form** — Every memory has a type (`preference`, `fact`, `conversation_summary`). This enables filtering, lifecycle policies, and structured queries.
4. **Local-first, single-file** — SQLite database at `~/.jarvis/memory.db`. No servers, no network, no accounts. One file to backup or delete.
5. **Opt-out, not opt-in** — Memory is on by default. Use `--no-memory` to disable for a single invocation.
6. **No silent accumulation** — The user should be able to inspect, search, and clear their memory at any time via `jarvis memory` subcommands.

---

## Architecture

```
User query
    │
    ▼
┌─────────────────────────────────┐
│  Auto-retrieval (pre-LLM call)  │
│  FTS5 search on user query      │
│  Top 3-5 results, ≤500 tokens   │
│  Injected as system context     │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Tool-calling loop              │
│  (chat-with-tools.ts)           │
│                                 │
│  LLM may call:                  │
│    memory_search(query, ...)    │
│    memory_store(content, ...)   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Post-session summarization     │
│  Summarize conversation → store │
│  as type: conversation_summary  │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  SQLite + FTS5                  │
│  ~/.jarvis/memory.db            │
└─────────────────────────────────┘
```

---

## Storage

### Backend

SQLite via `better-sqlite3`. Synchronous API, FTS5 built-in, zero-config.

The database lives at `~/.jarvis/memory.db` by default. Overridable via `JARVIS_MEMORY_DIR` env var.

### Schema

```sql
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('preference', 'fact', 'conversation_summary')),
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON array, e.g. '["typescript","auth"]'
  source      TEXT,            -- origin context, e.g. "chat 2026-02-25T14:30:00Z"
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  token_count INTEGER NOT NULL -- estimated token count of content
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,
  content=memories,
  content_rowid=id
);

-- Keep FTS index in sync
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags)
  VALUES (new.id, new.content, new.tags);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
  VALUES ('delete', old.id, old.content, old.tags);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
  VALUES ('delete', old.id, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags)
  VALUES (new.id, new.content, new.tags);
END;
```

Schema versioning via `PRAGMA user_version`. Incremented on each migration.

### Migration Lifecycle

- Migrations run automatically when memory is initialized (via `createMemoryService()` / `createMemoryDb()`).
- On startup, Jarvis checks `PRAGMA user_version` and runs forward migrations if needed.
- Current behavior is idempotent (`CREATE ... IF NOT EXISTS` + trigger creation safeguards), so repeated startups are safe.
- No manual migration command is required in phase 1.
- First migration occurs the first time any memory-enabled surface runs (`chat`, `chat-with-tools`, `telegram`, `serve`, or `jarvis memory ...`).

### Memory Types

| Type | Purpose | Example |
|---|---|---|
| `preference` | User-stated preferences and conventions | "I prefer functional patterns over classes" |
| `fact` | Learned factual knowledge about projects, systems, or domains | "Auth module uses JWT with 15-minute access tokens" |
| `conversation_summary` | Auto-generated summary of a completed session | "Discussed refactoring auth module. Decided to split into auth/tokens.ts and auth/sessions.ts." |

---

## Retrieval

### Auto-Retrieval (Passive)

Before the first LLM call in a memory-enabled interaction (`chat`, `chat-with-tools`, `telegram`, `serve`):

1. Run FTS5 search against the user's query.
2. Take top 5 results, sorted by relevance (FTS5 BM25 rank), with recency as a tiebreaker.
4. Sum token counts — stop adding results if the running total exceeds 500 tokens.
5. Format as a brief system message and prepend to the conversation.

**Format of injected context:**

```
Relevant context from memory:
- [preference] I prefer functional patterns over classes
- [fact, 2026-02-20] Auth module uses JWT with 15-minute access tokens
- [summary, 2026-02-18] Refactored auth module into separate token and session files
```

If no results are found, inject nothing. Silence is better than noise.

### Tool-Based Retrieval (Active)

The LLM can call `memory_search` to do a deeper, more targeted search — with filters, higher limits, or different queries than the user's original input.

### Ranking

FTS5's BM25 ranking handles relevance scoring. Results are sorted by rank (best match first) with
`created_at` descending as a tiebreaker. No custom scoring is required initially.

---

## Tools

### memory_search

**Intent**: Search memories by keyword query, optionally filtered by type or tags.

| Field | Detail |
|---|---|
| Input | `query` (required string), `type` (optional: preference/fact/conversation_summary), `limit` (optional, default 5, max 20) |
| Output | List of matching memories with id, content, type, tags, created_at, and relevance rank |

**Safeguards**:
- Results are bounded by `limit`. Default 5, hard max 20.
- Empty query returns recent memories (falls back to `getRecent`).
- Output is formatted compactly — no raw SQL or internal IDs exposed to the user unless debugging.

---

### memory_store

**Intent**: Explicitly store a piece of knowledge for future recall.

| Field | Detail |
|---|---|
| Input | `content` (required string), `type` (required: preference/fact/conversation_summary), `tags` (optional string array) |
| Output | Confirmation with memory ID and estimated token count |

**Safeguards**:
- Content is trimmed and validated non-empty.
- `type` must be one of the allowed enum values. Rejects unknown types.
- Duplicate detection: before inserting, check for an existing memory with highly similar content (exact match or near-exact after normalization). If found, return the existing memory instead of creating a duplicate.
- Token count is estimated at storage time (chars / 4 heuristic) and stored alongside content.
- Tags are validated as an array of non-empty strings. Malformed input is rejected, not silently fixed.
- No PII scrubbing — this is a local-only system. The user owns their data.

---

## Auto-Summarization

After each completed memory-enabled interaction:

1. Collect the full message array from the session.
2. Send a summarization prompt to the LLM in a separate, isolated call:
   ```
   Summarize this conversation in 2-4 sentences. Focus on decisions made,
   preferences expressed, and facts learned. Omit greetings and filler.
   ```
3. Store the summary as type `conversation_summary` with `source` set to `"chat {ISO timestamp}"`.
4. Skip summarization if the interaction was trivial. Current threshold:
   - summarize if any tool call happened, OR
   - summarize if total non-system message tokens are at least ~200.

**Safeguards**:
- Summarization is a separate LLM call — it does not consume context from the main conversation.
- If the summarization call fails (rate limit, network error), log a warning and continue. Memory is best-effort, never blocking.
- The summarization prompt is hardcoded and not user-configurable (prevents prompt injection into the memory layer).
- On graceful shutdown (`SIGINT`/`SIGTERM`), Jarvis waits briefly for in-flight summary writes before exit (bounded timeout).

---

## CLI Integration

### Flags

| Flag | Applies to | Effect |
|---|---|---|
| `--no-memory` | `chat`, `chat-with-tools`, `telegram`, `serve` | Disables memory retrieval/tools/summarization for that invocation |

### Subcommand: `jarvis memory`

| Command | Effect |
|---|---|
| `jarvis memory search [query]` | Search memories by keyword. Empty query falls back to recent memories. |
| `jarvis memory list [--type <type>] [--limit <n>]` | List recent memories, optionally filtered |
| `jarvis memory stats` | Count of memories by type, database file size, total estimated tokens |
| `jarvis memory clear [--type <type>] [--yes]` | Delete all memories or one type. Prompts for confirmation unless `--yes` is set. |
| `jarvis memory export` | Dump all memories as JSON to stdout |

---

## File Structure

```
src/memory/
├── db.ts          # Database connection, schema creation, migrations
├── service.ts     # MemoryService: search, store, getRecent, summarizeAndStore
├── types.ts       # Memory, MemoryType, MemorySearchResult, MemoryServiceConfig
└── index.ts       # Public exports

src/tools/
├── memory-search.ts   # memory_search tool implementation
├── memory-store.ts    # memory_store tool implementation
├── memory-tools.ts    # Tool factory wiring memory_search + memory_store
└── ...existing tools
```

---

## Safeguards (Summary)

| Risk | Mitigation |
|---|---|
| Context pollution | Auto-inject is capped at ~500 tokens / 5 results. Tool results are scoped to one turn. |
| Runaway storage growth | Token counts tracked per memory. `jarvis memory stats` surfaces total size. Future: TTL or LRU eviction for old summaries. |
| Duplicate memories | Near-exact duplicate detection on store. |
| Stale preferences | Preferences are not versioned. Duplicate/near-duplicate entries dedupe; changed preferences should be stored as new distinct memories. |
| Noise in auto-retrieval | Retrieval is bounded by result count/token budget and query matching. If nothing matches, nothing is injected. |
| Summarization failure | Best-effort. Failures are logged and swallowed — never block the main session. |
| Data sovereignty | Everything is local. Single SQLite file. User can delete `~/.jarvis/memory.db` at any time. `jarvis memory clear` for in-app deletion. |
| Prompt injection via stored memories | Memories are injected as user-attributed context, not as system instructions. The system prompt does not change based on memory content. |
| Broken schema on upgrade | Schema versioned via `PRAGMA user_version`. Migrations run forward-only on startup. |

---

## Future Extensions (Not in Scope Now)

- **Vector search**: Add `sqlite-vec` extension for semantic/embedding-based retrieval alongside FTS5. Same schema, new column for embeddings.
- **Per-project memory**: Optional `.jarvis/memory.db` in project root, layered on top of global memory.
- **Memory decay**: Reduce relevance of old memories over time. Weight recency more heavily in ranking.
- **Importance scoring**: Let the LLM tag memories with importance (1-5) at storage time. Use in retrieval ranking.
- **Conversation threading**: Link memories to conversation IDs for grouped recall.
