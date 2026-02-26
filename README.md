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
- A [synthetic.new](https://synthetic.new/) API key

## Getting Started

```bash
# Clone and install
git clone <repo-url>
cd jarvis
npm install

# Copy env file and configure
cp .env.example .env
```

Edit `.env` and set at minimum:

```
SYNTHETIC_API_KEY=your-api-key-here
DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4
```

Run `jarvis list-models` to see available models.

### Link the CLI (optional)

```bash
npm link
```

This lets you run `jarvis` from anywhere. Without it, use `node --experimental-strip-types src/cli.ts` instead.

## Usage

### CLI Chat

```bash
# Simple chat
jarvis chat "What is the capital of France?"

# Stream the response
jarvis chat "Explain quantum computing" --stream

# Specify model and temperature
jarvis chat "Hello" -m "hf:model-name" -t 0.9

# Read prompt from a file
jarvis chat --file ./prompt.txt

# Disable memory for one invocation
jarvis chat "Quick question" --no-memory
```

### Chat with Tools

Chat with tool calling enabled — Jarvis can read files, search code, run shell commands, and more.

```bash
jarvis chat-with-tools "Read README.md and summarize it"
jarvis chat-with-tools "What does package.json contain?"
jarvis chat-with-tools --file ./prompt.txt
jarvis chat-with-tools "Debug this" --no-memory
```

Available tools include: `read`, `glob`, `grep`, `edit`, `write`, `shell`, `ask_user`, `todo_list`, `web_fetch`, `sub_agent`, `read_file`, plus memory tools (`memory_search`, `memory_store`) when memory is enabled.

### Telegram Bot

Jarvis can run as a Telegram bot using long-polling — no public URL or server infrastructure required.

**Setup:**

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot
2. Copy the bot token and add it to your `.env`:
   ```
   TELEGRAM_BOT_TOKEN=your-token-here
   ```
3. Start the bot:
   ```bash
   jarvis telegram
   ```

**Options:**

```bash
jarvis telegram                          # uses DEFAULT_MODEL from .env
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
# Start with Telegram (token must be in .env)
jarvis serve -m "hf:model-name"

# Start with cron tasks
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

**Finding your Telegram chat ID:** Send any message to the bot running in `jarvis telegram` mode and check the logs for the `chatId` field.

### Skills

Skills are higher-level capabilities loaded in `serve` and `telegram` modes. They add tools to the LLM and can send proactive messages.

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

```bash
# Search/list/stats/export memory
jarvis memory search "jwt auth"
jarvis memory list --type preference --limit 20
jarvis memory stats
jarvis memory export

# Clear with confirmation (or bypass prompt for scripts)
jarvis memory clear
jarvis memory clear --type fact --yes
```

### List Models

```bash
jarvis list-models
jarvis list-models --json
```

## Architecture

```
Endpoints (Telegram, CLI)
        │
        ▼
    Dispatcher ──→ SessionStore (in-memory)
        │
        ▼
  chatWithTools() ──→ LLMClient + Tools (base + extra)
```

- **Endpoints** receive inbound messages and deliver outbound responses. Each endpoint declares a profile (max message length, tone, formatting) that shapes the system prompt.
- **Dispatcher** coordinates everything: resolves sessions, builds context-aware system prompts, calls the LLM, and routes responses back through the right endpoint. Accepts `extraTools` (e.g., reminder tools) alongside the base tool set.
- **Memory** provides durable recall via SQLite + FTS5 and is injected in bounded form when relevant.
- **Sessions** track conversation history per endpoint+user, keyed by IDs like `telegram:12345` or `cli:default`.
- **Triggers** (cron) send proactive messages through endpoints on a schedule.
- **Skills** are markdown instruction files (`src/skills/*.md`) that teach the agent how to combine tools. A compact summary from each skill's frontmatter is injected into the system prompt; the agent can `read` the full file for detailed guidance.

### Key Files

```
src/
├── cli.ts                 # CLI entry point (Commander.js)
├── dispatcher.ts          # Central coordinator
├── logger.ts              # Pino-based logging
├── endpoints/
│   ├── types.ts           # Endpoint, EndpointProfile, InboundMessage, OutboundMessage
│   ├── telegram.ts        # Telegram endpoint (grammy)
│   └── cli.ts             # CLI endpoint (stdout)
├── sessions/
│   ├── types.ts           # Session interface
│   └── store.ts           # In-memory session store
├── triggers/
│   └── cron.ts            # Interval-based scheduled tasks
├── memory/
│   ├── db.ts              # SQLite schema/migrations
│   ├── service.ts         # Memory service (search/store/summarize/stats)
│   └── types.ts           # Memory interfaces and enums
├── skills/
│   ├── types.ts           # SkillFrontmatter interface
│   ├── index.ts           # SkillRegistry: reads frontmatter, builds prompt block
│   └── reminder.md        # Reminder skill instructions
├── llm/
│   ├── client.ts          # LLMClient (OpenAI SDK wrapper)
│   ├── chat-with-tools.ts # Tool execution loop (supports dynamic tools)
│   ├── types.ts           # Shared interfaces
│   └── errors.ts          # Custom error classes
└── tools/
    ├── index.ts           # Base tool registry and executor
    ├── schedule-message.ts # Generic scheduled-message tools factory (+ persistence)
    ├── memory-search.ts   # memory_search tool
    ├── memory-store.ts    # memory_store tool
    ├── read.ts, glob.ts, grep.ts, edit.ts, write.ts, shell.ts, ...
    └── types.ts           # Tool type definitions (+ ToolExecutionContext)
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SYNTHETIC_API_KEY` | Yes | API key from [synthetic.new](https://synthetic.new/) |
| `DEFAULT_MODEL` | No | Default model (avoids `-m` flag every time) |
| `TELEGRAM_BOT_TOKEN` | For Telegram | Bot token from [@BotFather](https://t.me/BotFather) |
| `JARVIS_MEMORY_DIR` | No | Directory for memory database (default `~/.jarvis`) |
| `JARVIS_LOG_LEVEL` | No | Log level (`debug`, `info`, `warn`, `error`, `silent`) |
| `JARVIS_LOG_FILE` | No | Path to write logs to a file |

## Development

```bash
# Run all tests
npm test

# Run a single test file
node --experimental-strip-types --test src/sessions/store.test.ts

# CLI smoke check
node --experimental-strip-types src/cli.ts --help
```

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
