# README.md Architecture Section Update

## Architecture Section (Replace existing)

```
Endpoints (Telegram, CLI, HTTP)
         │
         ▼
    Dispatcher ──→ SessionStore (in-memory)
         │
         ▼
   chatWithTools() ──→ LLMClient + Tools
         │
         ├── Memory Worker (SQLite/FTS5)
         ├── Search Worker Pool (Glob/Grep)
         └── Shell Process Pool
```

- **Endpoints** receive inbound messages and deliver outbound responses. Each endpoint declares a profile (max message length, tone, formatting) that shapes the system prompt.
- **Dispatcher** coordinates everything: resolves sessions, builds context-aware system prompts, calls the LLM, and routes responses back through the right endpoint. Accepts `extraTools` (e.g., reminder tools) alongside the base tool set.
- **Memory Worker** runs SQLite operations in a dedicated worker thread to keep the main event loop responsive. Provides durable recall via SQLite + FTS5 and is injected in bounded form when relevant.
- **Search Worker Pool** handles file globbing and grepping in parallel worker threads (2 workers by default), preventing large codebase searches from blocking.
- **Shell Process Pool** isolates shell command execution with concurrency limits (3 concurrent by default) and queue management.
- **Sessions** track conversation history per endpoint+user, keyed by IDs like `telegram:12345` or `cli:default`.
- **Triggers** (cron) send proactive messages through endpoints on a schedule.
- **Skills** are markdown instruction files (`src/skills/*.md`) that teach the agent how to combine tools. A compact summary from each skill's frontmatter is injected into the system prompt; the agent can `read` the full file for detailed guidance.
- **Parallel Tool Execution** - Independent tool calls execute concurrently (up to 5 by default) with results ordered for the LLM.

---

## Key Files Section (Update the tree)

Add under `src/memory/`:
```
├── memory/
│   ├── db.ts              # SQLite schema/migrations
│   ├── service.ts         # Memory service (async interface)
│   ├── helpers.ts         # Pure functions shared with worker
│   └── types.ts           # Memory interfaces and enums
```

Add new section:
```
├── workers/
│   ├── memory-worker.ts       # SQLite worker thread
│   ├── memory-worker-client.ts # Main thread interface
│   ├── search-worker.ts       # File search worker
│   ├── search-worker-pool.ts # Round-robin pool (2 workers)
│   ├── types.ts             # WorkerRequest/WorkerResponse
│   └── index.ts             # Public exports
├── shell/
│   ├── pool.ts              # Shell process pool (3 concurrent)
│   ├── types.ts             # ShellJob, ShellResult interfaces
│   └── index.ts             # Public exports
```

Update `src/llm/chat-with-tools.ts` comment:
```
├── llm/
│   ├── client.ts          # LLMClient (OpenAI SDK wrapper)
│   ├── chat-with-tools.ts # Tool execution loop (parallel)
```

---

## New Performance Characteristics Section

Add after Architecture:

```markdown
## Performance Characteristics

Jarvis uses worker threads and process pools to maintain responsiveness:

### Worker Thread Architecture

- **Memory Worker**: SQLite operations run in a dedicated worker thread, preventing database queries from blocking the event loop
- **Search Workers**: File globbing and grepping use a pool of 2 worker threads with round-robin scheduling
- **Shell Pool**: Shell commands execute in isolated child processes with a concurrency limit of 3 (queuing when at capacity)

### Parallel Tool Execution

When the LLM requests multiple tools in a single response, they execute concurrently:
- Default: Up to 5 tools in parallel
- Results ordered by original request order for the LLM

### Typical Response Times

| Operation | Before | After |
|-----------|--------|-------|
| Memory FTS5 search | 50-200ms (blocking) | 1-200ms (non-blocking) |
| Grep large codebase | 500ms-2s (blocking) | 500ms-2s (non-blocking) |
| Multi-tool chain | Sum of all (sequential) | Parallel execution |
```

---

## New Troubleshooting Section

Add before Development:

```markdown
## Troubleshooting

### Worker Thread Issues

**Symptom**: "Memory worker error" in logs  
**Cause**: Worker thread crashed (usually SQLite error)  
**Fix**: Worker auto-respawns. Check logs for underlying SQLite error.

**Symptom**: Shell commands timeout  
**Cause**: Shell pool at capacity or command hung  
**Fix**: Check logs. Long-running commands may need increased timeout.

**Symptom**: High memory usage  
**Cause**: Worker threads accumulate memory  
**Fix**: Workers restart on crash, but gradual leaks require process restart.

### Memory Issues

**Symptom**: Memory search returns no results  
**Check**: `jarvis memory stats` - is database populated?  
**Check**: `jarvis memory search "test" --type fact` - does basic search work?
```

---

## Update Development Section

Add worker thread tests:

```bash
# Run a single test file
node --experimental-strip-types --test src/sessions/store.test.ts
node --experimental-strip-types --test src/workers/memory-worker-client.test.ts
node --experimental-strip-types --test src/workers/search-worker-pool.test.ts
node --experimental-strip-types --test src/shell/pool.test.ts
```
