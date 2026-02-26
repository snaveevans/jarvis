# Process Separation Spec

Moving blocking operations to worker threads for a responsive single-user system.

---

## Intent

Jarvis currently runs everything on the main Node.js event loop. SQLite operations (via `better-sqlite3`) are synchronous and block the loop. Large file searches and shell commands can also cause noticeable delays. For a single-user system running on bare metal, we need:

1. **Non-blocking memory operations** — SQLite should never freeze the event loop
2. **Parallel tool execution** — Independent tools should run concurrently, not sequentially
3. **Resource isolation** — Shell commands get their own process space with limits
4. **Simple deployment** — No external services (Redis, queues), minimal moving parts

---

## Design Principles

1. **Worker threads, not processes** — Lighter weight than separate processes, shared memory possible, no IPC overhead
2. **Bare metal friendly** — No Docker, no orchestration, runs directly on Ubuntu
3. **Single-user optimized** — No multi-tenancy, no horizontal scaling concerns
4. **Graceful degradation** — If a worker fails, the main process continues
5. **Minimal API changes** — Existing tool signatures stay the same

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Main Thread                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   CLI/      │  │  Telegram   │  │   HTTP      │  │  Scheduler  │ │
│  │   Chat      │  │   Bot       │  │   Server    │  │             │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                │                │                │        │
│         └────────────────┴────────────────┴────────────────┘        │
│                                    │                                │
│                           ┌────────▼────────┐                     │
│                           │    Dispatcher     │                     │
│                           │   (event loop)    │                     │
│                           └────────┬────────┘                     │
│                                    │                                │
│                    ┌───────────────┼───────────────┐                 │
│                    │               │               │                 │
│              ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐          │
│              │   Tool    │  │   Tool    │  │   Tool    │          │
│              │ Execution │  │ Execution │  │   Loop    │          │
│              │  (async)  │  │  (async)  │  │           │          │
│              └─────┬─────┘  └─────┬─────┘  └─────┬─────┘          │
└────────────────────┼──────────────┼──────────────┼──────────────────┘
                     │              │              │
        ┌────────────┴──────────────┴──────────────┴────────────┐
        │                  Worker Threads                        │
        │  ┌─────────────────┐  ┌─────────────────────────────┐│
        │  │   Memory Worker │  │      Search Worker          ││
        │  │   (SQLite/FTS5) │  │   (Glob/Grep/File I/O)      ││
        │  │                 │  │                             ││
        │  │  - better-sqlite3│  │  - Fast-glob                ││
        │  │  - All DB ops   │  │  - Ripgrep via child proc   ││
        │  │  - Schema mgmt  │  │  - Parallel file reads      ││
        │  └─────────────────┘  └─────────────────────────────┘│
        └───────────────────────────────────────────────────────┘
                              │
                     ┌────────▼────────┐
                     │  Process Pool   │
                     │  (Shell Exec)   │
                     │                 │
                     │  - Resource     │
                     │    limits       │
                     │  - Timeout      │
                     │    enforcement  │
                     │  - Queue when   │
                     │    at capacity  │
                     └─────────────────┘
```

---

## Worker Thread Design

### Why Worker Threads?

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Worker Threads** | Shared memory possible, low overhead, native Node.js support | Limited to Node.js, can't use native modules easily | **Use this** |
| **Child Processes** | Can use any binary, process isolation | Higher overhead, serialization cost, harder to debug | Shell only |
| **Separate Services** | Language agnostic, can scale separately | Requires orchestration, network overhead, overkill | Not for single-user |

### Worker Communication

Use Node.js `worker_threads` with `MessageChannel` for request/response pattern:

```typescript
// Main thread sends request
const response = await memoryWorker.request({
  method: 'search',
  params: { query: 'auth', limit: 5 }
})

// Worker thread processes and returns
// SQLite operations happen on worker's event loop (blocking OK)
```

---

## Component Specifications

### 1. Memory Worker Thread

**Purpose**: Offload all SQLite operations from the main thread

**Responsibilities**:
- Database initialization and migrations
- Full-text search (FTS5)
- Memory CRUD operations
- Deduplication logic
- Auto-summarization (triggered from main, executed on worker)

**API**:

```typescript
interface MemoryWorkerRequest {
  method: 'search' | 'store' | 'getRecent' | 'getStats' | 'clear' | 'export'
  params: Record<string, unknown>
  requestId: string
}

interface MemoryWorkerResponse {
  requestId: string
  result?: unknown
  error?: string
}
```

**File Structure**:
```
src/workers/
├── memory-worker.ts      # Worker entry point
├── memory-worker-pool.ts # Main thread interface
└── types.ts              # Shared types
```

**Implementation Notes**:
- Single persistent worker (no need for pooling, SQLite handles concurrency via WAL mode)
- Uses `better-sqlite3` natively (synchronous is OK in worker thread)
- Main thread communicates via `MessagePort`
- Keep connection open for entire process lifetime
- On worker crash: restart and reinitialize connection

---

### 2. Search Worker Thread

**Purpose**: Handle CPU-intensive file search operations

**Responsibilities**:
- Glob pattern matching
- Grep/regex file content search
- File content reading (large files)
- Parallel directory traversal

**API**:

```typescript
interface SearchWorkerRequest {
  method: 'glob' | 'grep' | 'readFile'
  params: { pattern: string; path?: string; /* ... */ }
  requestId: string
}
```

**Implementation Notes**:
- Can spawn multiple workers for parallel searches (pool of 2-4)
- Use `fast-glob` for directory traversal
- For grep: shell out to `ripgrep` (rg) if available, fallback to JS regex
- Bound results to prevent memory explosion

**File Structure**:
```
src/workers/
├── search-worker.ts      # Worker entry point
├── search-worker-pool.ts # Pool management
└── ...existing types
```

---

### 3. Shell Process Pool

**Purpose**: Isolate shell command execution with resource limits

**Current State**: Spawns child processes directly on main thread

**New Design**:
- Pool of reusable shell process workers (max 3 concurrent)
- Queue when at capacity
- Resource limits: CPU, memory, execution time
- Timeout enforcement (hard kill after timeout)

**Why Child Processes**:
- Shell commands need process isolation anyway
- Can apply OS-level resource limits (cgroups on Linux)
- Natural fit for pooling

**API**:

```typescript
interface ShellJob {
  command: string
  timeout: number
  maxBuffer: number
  cwd?: string
}

interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  duration: number
}
```

**File Structure**:
```
src/shell/
├── pool.ts              # Process pool management
├── worker.ts            # Shell worker process
└── types.ts             # Interfaces
```

---

### 4. Parallel Tool Execution

**Current**: Tools execute sequentially in a loop

**New**: Execute independent tools in parallel within the same `chatWithTools` iteration

```typescript
// Before (sequential)
for (const toolCall of toolCalls) {
  const result = await executeTool(toolCall)  // One at a time
}

// After (parallel)
const results = await Promise.allSettled(
  toolCalls.map(tc => executeTool(tc))  // Concurrent
)
```

**Constraints**:
- Tools with same `sessionId` can run in parallel
- Respect max parallel limit (e.g., 5 concurrent)
- Order results by original request order for LLM

---

## Implementation Phases

### Phase 1: Memory Worker (Week 1)

**Goal**: Move SQLite operations to worker thread

**Tasks**:
1. Create `src/workers/memory-worker.ts`
   - Import `better-sqlite3`, initialize DB
   - Handle message passing from main thread
   - Implement all memory service methods

2. Create `src/workers/memory-worker-client.ts`
   - Main thread interface
   - Wrap MessagePort in Promise-based API
   - Handle worker lifecycle (spawn, restart on crash)

3. Refactor `MemoryService`
   - Replace direct DB calls with worker client calls
   - Keep same public API for backward compatibility

4. Update `createMemoryService()` factory
   - Spawn worker on initialization
   - Terminate worker on cleanup

**Testing**:
- Worker spawns correctly
- All memory operations work via worker
- Worker restart on crash
- Graceful shutdown (finish pending ops)

**Files Changed**:
- `src/memory/service.ts` — Use worker client
- `src/memory/db.ts` — Move to worker
- New: `src/workers/` directory

---

### Phase 2: Parallel Tool Execution (Week 1-2)

**Goal**: Execute independent tools concurrently

**Tasks**:
1. Modify `chat-with-tools.ts`
   - Change tool execution loop to `Promise.allSettled`
   - Maintain result ordering
   - Add concurrency limit

2. Update `executeTool()` in `src/tools/index.ts`
   - Ensure all tools are async-safe
   - No shared mutable state between concurrent calls

3. Add tool execution metrics
   - Track duration per tool
   - Log slow tools

**Testing**:
- Multiple tools execute in parallel
- Results ordered correctly for LLM
- Errors handled gracefully (one failure doesn't block others)

---

### Phase 3: Search Worker (Week 2)

**Goal**: Move file search operations to worker thread

**Tasks**:
1. Create `src/workers/search-worker.ts`
   - Handle glob/grep operations
   - Use `fast-glob` for performance
   - Delegate to `ripgrep` when available

2. Create `src/workers/search-worker-pool.ts`
   - Pool of 2-4 workers
   - Round-robin or least-busy scheduling

3. Refactor `src/tools/glob.ts` and `src/tools/grep.ts`
   - Use search worker pool
   - Keep same public API

**Testing**:
- Parallel searches on large codebases
- Worker pool scales correctly
- Graceful degradation if workers fail

---

### Phase 4: Shell Process Pool (Week 3)

**Goal**: Isolate shell commands with resource limits

**Tasks**:
1. Create `src/shell/pool.ts`
   - Process pool with max concurrent
   - Queue management
   - Resource tracking

2. Create `src/shell/worker.ts`
   - Shell command execution
   - Timeout enforcement
   - Resource limit application (Linux cgroups or ulimit)

3. Refactor `src/tools/shell.ts`
   - Use process pool instead of direct spawn
   - Keep same API

4. Add monitoring
   - Queue depth metrics
   - Execution time histograms

**Testing**:
- Commands queue when at capacity
- Timeouts enforced
- Resource limits applied
- Pool recycles workers

---

## Deployment Considerations

### Bare Metal Ubuntu

**Requirements**:
- Node.js v22+ (already required)
- `ripgrep` (rg) installed for fast grep: `apt-get install ripgrep`
- Linux cgroups v2 for resource limits (Ubuntu 22.04+ has this)

**No External Dependencies**:
- No Redis
- No message queue
- No Docker
- Single process with internal workers

### System Limits

Check/adjust these for production:

```bash
# File descriptors (for many concurrent file operations)
ulimit -n 4096

# Max user processes (for worker threads)
ulimit -u 2048

# Enable cgroups v2 (Ubuntu 22.04+)
cat /sys/fs/cgroup/cgroup.controllers
```

### Monitoring

Since this is bare metal, use simple logging:

```typescript
// Log worker events
logger.info('Memory worker spawned', { pid: worker.threadId })
logger.info('Search worker pool size', { count: pool.size })
logger.info('Shell queue depth', { depth: pool.queueLength })

// Log slow operations
if (duration > 1000) {
  logger.warn('Slow memory operation', { method, duration })
}
```

---

## Error Handling

### Worker Thread Errors

```typescript
// Worker crash
worker.on('error', (err) => {
  logger.error('Worker crashed', { threadId, error: err })
  // Restart worker
  spawnNewWorker()
})

// Request timeout
const result = await Promise.race([
  worker.request(params),
  delay(MAX_REQUEST_TIME).then(() => {
    throw new Error('Worker request timeout')
  })
])
```

### Graceful Degradation

- **Memory worker fails**: Disable memory for session, log error
- **Search worker fails**: Fall back to main thread (slower but works)
- **Shell pool full**: Queue indefinitely (user expects wait)
- **Worker restart**: Reinitialize state, re-run pending requests

---

## Performance Expectations

### Before Process Separation

| Operation | Time | Impact |
|-----------|------|--------|
| SQLite FTS5 (small DB) | 1-10ms | Unnoticeable |
| SQLite FTS5 (10K rows) | 50-200ms | Event loop blocked |
| Grep large codebase | 500ms-2s | Event loop blocked |
| Shell command | Variable | Event loop blocked |
| Sequential tools | Sum of all | Slow chain |

### After Process Separation

| Operation | Time | Impact |
|-----------|------|--------|
| SQLite FTS5 (any size) | 1-200ms | No impact (off main thread) |
| Grep large codebase | 500ms-2s | No impact (off main thread) |
| Shell command | Variable | Isolated process |
| Sequential tools | Parallel | Much faster |

---

## Files to Create/Modify

### New Files

```
src/workers/
├── memory-worker.ts        # SQLite worker thread
├── memory-worker-client.ts # Main thread interface
├── search-worker.ts        # File search worker
├── search-worker-pool.ts   # Pool management
├── types.ts                # Shared interfaces
└── index.ts                # Public exports

src/shell/
├── pool.ts                 # Shell process pool
├── worker.ts               # Shell worker process
├── types.ts                # Interfaces
└── index.ts                # Public exports
```

### Modified Files

```
src/memory/
├── service.ts              # Use worker client
└── db.ts                   # Remove (moved to worker)

src/tools/
├── shell.ts                # Use process pool
├── glob.ts                 # Use search worker
└── grep.ts                 # Use search worker

src/llm/
└── chat-with-tools.ts      # Parallel execution
```

---

## Future Considerations

### Not in Scope (But Possible Later)

1. **Persistent queue for scheduled messages** — Currently in-memory timers + JSON. Could add SQLite persistence for queue.

2. **Background summarization** — Currently best-effort async. Could move to dedicated worker for reliability.

3. **Hot reload workers** — Restart workers on code changes during development.

4. **Resource metrics endpoint** — If we add HTTP server, expose `/metrics` for Prometheus.

---

## Success Criteria

1. **Event loop never blocked** — SQLite operations don't freeze the UI
2. **Faster tool chains** — Parallel execution reduces total time
3. **Shell isolation** — Shell commands can't bring down main process
4. **Same API** — No breaking changes to existing code
5. **Simple deployment** — Still just `npm install && node src/cli.ts`

---

## Decision Log

### Worker threads over processes

- **Date**: 2026-02-26
- **Decision**: Use Node.js worker threads for CPU/IO work, child processes only for shell
- **Context**: Worker threads are lighter, share memory, have less IPC overhead. Child processes needed for shell anyway (process isolation). Single-user system doesn't need full microservices.
- **Consequences**: Simpler architecture, faster communication, but limited to Node.js ecosystem. Shell commands still get true process isolation.

### No external services (Redis, queues)

- **Date**: 2026-02-26
- **Decision**: Keep everything in-process, no external dependencies
- **Context**: This is a single-user bare metal system. External services add operational complexity (install, configure, monitor) that isn't justified for one user.
- **Consequences**: Can't scale horizontally, but that's fine. Memory is local, SQLite is local, workers are local. Deployment is just Node.js + ripgrep.

### Keep SQLite, don't replace

- **Date**: 2026-02-26
- **Decision**: Move SQLite to worker thread, don't replace with external DB
- **Context**: SQLite works well, has FTS5, is zero-config. Moving to worker thread solves the blocking issue without losing benefits.
- **Consequences**: Still single-writer (WAL mode handles this), but now non-blocking from main thread perspective.

---

## References

- Node.js Worker Threads: https://nodejs.org/api/worker_threads.html
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- fast-glob: https://github.com/mrmlnc/fast-glob
- ripgrep: https://github.com/BurntSushi/ripgrep
- Linux cgroups v2: https://docs.kernel.org/admin-guide/cgroup-v2.html
