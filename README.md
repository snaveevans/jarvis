# Jarvis

An AI assistant and digital familiar inspired by J.A.R.V.I.S. (Just A Rather Very Intelligent System) from the Marvel Universe—the iconic digital assistant of Tony Stark.

## About This Project

Jarvis is being built **incrementally and deliberately**. This is not a code knockout project with one giant PR. Instead, we're constructing it piece by piece, using it along the way as a learning platform and experimentation ground.

### Guiding Principles

- **Incremental Development**: Small, focused additions that can be tested and validated before moving forward
- **Learning-First**: Each component is an opportunity to explore new technologies and patterns
- **Pragmatic**: Build what works, discard what doesn't, iterate based on real usage

## Requirements

- **Node.js v22+** (uses native TypeScript execution via `--experimental-strip-types`)
- An API key for a supported LLM provider ([synthetic.new](https://synthetic.new/), MiniMax, or any OpenAI-compatible API)

## Getting Started

### Development (with .env file)

```bash
git clone <repo-url>
cd jarvis
npm install        # installs deps and creates .env from .env.example
# edit .env — add your API keys
npm run dev chat "Hello!"
npm run dev list-models
```

### Production (with environment variables)

```bash
npm install
npm link           # installs jarvis as a global CLI command

# Set environment variables directly
export SYNTHETIC_API_KEY=your-key-here
export DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4

jarvis list-models # verify setup
jarvis serve       # run in production mode
```

→ **See [INSTALL.md](./INSTALL.md) for the full step-by-step installation guide**, including provider setup, Telegram bot configuration, running as a background service, and troubleshooting.

## Usage

### CLI Chat

**Development mode** (loads `.env` file):

```bash
# Simple chat
npm run dev chat "What is the capital of France?"

# Stream the response
npm run dev chat "Explain quantum computing" -- --stream

# Specify model and temperature
npm run dev chat "Hello" -- -m "hf:model-name" -t 0.9

# Read prompt from a file
npm run dev chat -- --file ./prompt.txt

# Disable memory for one invocation
npm run dev chat "Quick question" -- --no-memory
```

**Production mode** (uses environment variables):

```bash
# Set environment variables first
export SYNTHETIC_API_KEY=your-key-here
export DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4

# Then use jarvis command directly
jarvis chat "What is the capital of France?"
jarvis chat "Explain quantum computing" --stream
jarvis chat "Hello" -m "hf:model-name" -t 0.9
```

### Chat with Tools

Chat with tool calling enabled — Jarvis can read files, search code, run shell commands, and more.

**Development mode**:

```bash
npm run dev chat-with-tools "Read README.md and summarize it"
npm run dev chat-with-tools "What does package.json contain?"
npm run dev chat-with-tools -- --file ./prompt.txt
npm run dev chat-with-tools "Debug this" -- --no-memory
```

**Production mode**:

```bash
jarvis chat-with-tools "Read README.md and summarize it"
jarvis chat-with-tools "What does package.json contain?"
jarvis chat-with-tools --file ./prompt.txt
jarvis chat-with-tools "Debug this" --no-memory
```

Available tools include: `read`, `glob`, `grep`, `edit`, `write`, `shell`, `ask_user`, `todo_list`, `web_fetch`, `web_search`, `sub_agent`, `read_file`, plus memory tools (`memory_search`, `memory_store`, `memory_delete`) when memory is enabled. In `serve`/`telegram` modes: `schedule_message`, `list_scheduled_messages`, `cancel_scheduled_message`, `health_check`, `introspect`, `read_logs`, and skill management tools.

### Telegram Bot

Jarvis can run as a Telegram bot using long-polling — no public URL or server infrastructure required.

**Setup:**

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot
2. Copy the bot token and either:
   - **Development**: Add it to your `.env` file
   - **Production**: Set as environment variable

   ```bash
   # Development (.env file)
   TELEGRAM_BOT_TOKEN=your-token-here
   
   # Production (environment variable)
   export TELEGRAM_BOT_TOKEN=your-token-here
   ```

3. Start the bot:

   ```bash
   # Development
   npm run dev telegram
   
   # Production
   jarvis telegram
   ```

**Options:**

```bash
# Development
npm run dev telegram                              # uses DEFAULT_MODEL from .env
npm run dev telegram -- -m "hf:model-name"        # specify model
npm run dev telegram -- -s "You are a pirate"     # custom system prompt
npm run dev telegram -- --log-file ./bot.log      # write logs to file

# Production
jarvis telegram                          # uses DEFAULT_MODEL from environment
jarvis telegram -m "hf:model-name"       # specify model
jarvis telegram -s "You are a pirate"    # custom system prompt
jarvis telegram --log-file ./bot.log     # write logs to file
```

**In-chat commands:**

- Send any text message to chat with the LLM
- `/clear` — reset conversation history

The bot maintains per-chat conversation history in memory (resets on restart). Long responses are automatically split across multiple messages.

### Serve Mode

Run Jarvis as a long-running service with all endpoints and optional scheduled tasks.

```bash
# Development (.env loaded)
npm run dev serve -- -m "hf:model-name"

# Production (environment variables)
export SYNTHETIC_API_KEY=your-key-here
export DEFAULT_MODEL=hf:model-name
export TELEGRAM_BOT_TOKEN=your-token-here
jarvis serve

# With cron tasks
jarvis serve -m "hf:model-name" --cron '[
  {
    "name": "daily-checkin",
    "intervalMs": 86400000,
    "targetSessionId": "telegram:YOUR_CHAT_ID",
    "targetEndpointKind": "telegram",
    "prompt": "Give me a morning briefing."
  }
]'
```

Serve mode automatically registers any available endpoints (Telegram if `TELEGRAM_BOT_TOKEN` is set), initializes all skills (reminder, etc.), and starts cron tasks. Ctrl+C for graceful shutdown.

**Finding your Telegram chat ID:** Send any message to the bot and check the logs for the `chatId` field.

### Skills

Skills are higher-level capabilities loaded in `serve` and `telegram` modes. They add instructions to the system prompt and can leverage tools for proactive behavior.

Built-in skills: **Reminder**, **Memory**, **Introspection**.

**Reminder** — set, list, and cancel time-based reminders:

```
You: "Remind me in 30 minutes to take the laundry out"
Jarvis: Reminder set. Will fire in 30 minute(s).
... 30 minutes later ...
Jarvis: Reminder: take the laundry out
```

Reminder data persists to `data/scheduled-messages.json` and survives process restarts.
Cancellation is session-scoped by default; use `cancel_scheduled_message(message_id, global=true)` for explicit cross-session cancellation.

### Memory

Jarvis includes local durable memory backed by SQLite (`~/.jarvis/memory.db` by default). It uses bounded auto-retrieval to add relevant context without bloating prompts.
Schema migration is automatic on first memory use; no manual migration command is required.
Auto-summaries use a rolling session window (default 30 minutes) and avoid re-summarizing already covered message ranges.

```bash
# Search/list/stats/export memory
jarvis memory search "jwt auth"
jarvis memory list --type preference --limit 20
jarvis memory stats
jarvis memory export

# Clear with confirmation (or bypass prompt for scripts)
jarvis memory clear
jarvis memory clear --type fact --yes

# Configure rolling auto-summary window
jarvis serve --memory-summary-window-minutes 45

# Or via environment variable
export JARVIS_MEMORY_SUMMARY_WINDOW_MINUTES=45
```

### List Models

```bash
jarvis list-models
jarvis list-models --json
```

## Architecture

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

### Key Files

```
src/
├── cli.ts                 # CLI entry point (Commander.js)
├── dispatcher.ts          # Central coordinator
├── config.ts              # Configuration loader (c12 + Zod)
├── logger.ts              # Pino-based logging
├── endpoints/
│   ├── types.ts           # Endpoint, EndpointProfile, InboundMessage, OutboundMessage
│   ├── telegram.ts        # Telegram endpoint (grammy)
│   └── cli.ts             # CLI endpoint (stdout)
├── sessions/
│   ├── types.ts           # Session interface
│   ├── store.ts           # In-memory session store
│   └── history-store.ts   # Session history persistence (SQLite)
├── triggers/
│   └── cron.ts            # Interval-based scheduled tasks
├── search/
│   └── providers/         # Web search backends (Brave, Synthetic)
├── memory/
│   ├── db.ts              # SQLite schema/migrations
│   ├── service.ts         # Memory service (async interface)
│   ├── helpers.ts         # Pure functions shared with worker
│   ├── eviction-evaluator.ts # Memory eviction logic
│   └── types.ts           # Memory interfaces and enums
├── workers/
│   ├── memory-worker.ts       # SQLite worker thread
│   ├── memory-worker-client.ts # Main thread interface
│   ├── search-worker.ts       # File search worker
│   ├── search-worker-pool.ts # Round-robin pool (2 workers)
│   └── types.ts               # WorkerRequest/WorkerResponse
├── shell/
│   ├── pool.ts                # Shell process pool (3 concurrent)
│   └── types.ts               # ShellJob, ShellResult interfaces
├── telemetry/
│   └── event-store.ts    # In-memory event ring buffer
├── skills/
│   ├── index.ts           # SkillRegistry: reads frontmatter, builds prompt block
│   ├── reminder.md        # Reminder skill
│   ├── memory.md          # Memory skill
│   └── introspection.md   # Introspection skill
├── llm/
│   ├── client.ts          # LLMClient (OpenAI SDK wrapper)
│   ├── provider.ts        # Provider abstraction and selection
│   ├── chat-with-tools.ts # Tool execution loop (parallel)
│   ├── types.ts           # Shared interfaces
│   └── errors.ts          # Custom error classes
└── tools/
    ├── index.ts           # Base tool registry and executor
    ├── schedule-message.ts # Scheduled-message tools factory
    ├── memory-tools.ts    # Memory tool factory
    ├── memory-search.ts, memory-store.ts, memory-delete.ts
    ├── web-search.ts      # Web search (Brave/Synthetic)
    ├── health-check.ts, introspect.ts, read-logs.ts
    ├── skill-manager.ts   # Skill management (create/list/remove)
    ├── read.ts, glob.ts, grep.ts, edit.ts, write.ts, shell.ts, ...
    └── types.ts           # Tool types + ToolExecutionContext
```

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

| Operation           | Before                  | After                   |
| ------------------- | ----------------------- | ----------------------- |
| Memory FTS5 search  | 50-200ms (blocking)     | 1-200ms (non-blocking)  |
| Grep large codebase | 500ms-2s (blocking)     | 500ms-2s (non-blocking) |
| Multi-tool chain    | Sum of all (sequential) | Parallel execution      |

## Environment Variables

| Variable                               | Required            | Description                                                       |
| -------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `LLM_PROVIDER`                         | No                  | Active provider (`synthetic`, `minimax`, `openai-compatible`)     |
| `SYNTHETIC_API_KEY`                    | For synthetic       | API key for synthetic provider                                    |
| `SYNTHETIC_BASE_URL`                   | No                  | Base URL for synthetic provider                                   |
| `SYNTHETIC_DEFAULT_MODEL`              | No                  | Default model for synthetic provider                              |
| `MINIMAX_API_KEY`                      | For minimax         | API key for MiniMax provider                                      |
| `MINIMAX_BASE_URL`                     | No                  | Base URL for MiniMax provider                                     |
| `MINIMAX_DEFAULT_MODEL`                | No                  | Default model for MiniMax provider                                |
| `OPENAI_API_KEY`                       | For minimax (alias) | Alias for `MINIMAX_API_KEY`                                       |
| `OPENAI_BASE_URL`                      | No (alias)          | Alias for `MINIMAX_BASE_URL`                                      |
| `OPENAI_COMPATIBLE_DEFAULT_MODEL`      | No                  | Default model for `openai-compatible` provider                    |
| `LLM_API_KEY`                          | No                  | Override key for active provider                                  |
| `LLM_BASE_URL`                         | No                  | Override base URL for active provider                             |
| `DEFAULT_MODEL`                        | No                  | Global model override for active provider                         |
| `TELEGRAM_BOT_TOKEN`                   | For Telegram        | Bot token from [@BotFather](https://t.me/BotFather)               |
| `JARVIS_MEMORY_DIR`                    | No                  | Directory for memory database (default `~/.jarvis`)               |
| `JARVIS_MEMORY_ARCHIVE_RETENTION_DAYS` | No                  | Days to retain archived memories before hard purge (default 14)   |
| `JARVIS_MEMORY_SUMMARY_WINDOW_MINUTES` | No                  | Rolling auto-summary window (minutes) for dispatcher-backed flows |
| `JARVIS_LOG_LEVEL`                     | No                  | Log level (`debug`, `info`, `warn`, `error`, `silent`)            |
| `JARVIS_LOG_FILE`                      | No                  | Path to write logs to a file                                      |

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

## Development

```bash
# Run all tests
npm test

# Run a single test file
node --experimental-strip-types --test src/sessions/store.test.ts
node --experimental-strip-types --test src/workers/memory-worker-client.test.ts
node --experimental-strip-types --test src/workers/search-worker-pool.test.ts
node --experimental-strip-types --test src/shell/pool.test.ts

# CLI smoke check
node --experimental-strip-types src/cli.ts --help
```

### Worker Thread Debugging

Worker threads run in separate contexts. To debug:

1. Add logging in worker code (`console.log` outputs to main process stderr)
2. Check `logger` output for worker spawn/exit events
3. Tests run in isolated contexts - use `test()` not `describe()` for worker tests

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines, code style, and conventions.

## Roadmap

The vision for Jarvis includes (in no particular order):

- Voice interaction and natural language understanding
- System integration and automation
- Context-aware assistance
- Learning and personalization
- Cross-platform accessibility
- Security and privacy-first design

## Contributing

This is a personal project, but feedback and ideas are welcome.

## License

MIT
