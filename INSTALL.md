# Installing Jarvis

A step-by-step guide to getting Jarvis running on your machine.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | **v22 or later** | Uses native TypeScript execution (`--experimental-strip-types`) |
| **npm** | v10+ | Bundled with Node.js v22 |
| **Git** | Any | To clone the repository |
| **API key** | — | See [Getting an API Key](#getting-an-api-key) |

### Check your Node.js version

```bash
node --version
# Must print v22.x.x or higher
```

If you need to upgrade, use [nvm](https://github.com/nvm-sh/nvm) (recommended):

```bash
nvm install 22
nvm use 22
```

---

## Quick Start (5 steps)

```bash
# 1. Clone the repository
git clone <repo-url>
cd jarvis

# 2. Install dependencies (also auto-creates .env from .env.example)
npm install

# 3. Add your API key to .env
#    Open .env and set SYNTHETIC_API_KEY=your-key-here
#    (or follow the provider-specific setup below)

# 4. Link the CLI globally
npm link

# 5. Verify
jarvis --version
jarvis list-models
```

---

## Step-by-Step Setup

### Step 1 — Clone and install

```bash
git clone <repo-url>
cd jarvis
npm install
```

`npm install` automatically creates a `.env` file from `.env.example` if one doesn't exist yet.

---

### Step 2 — Configure your API key

Open `.env` in your editor:

```bash
# macOS / Linux
nano .env
# or
code .env
```

Set the required variables for your provider:

#### Provider A: Synthetic (default)

Get a key at [synthetic.new](https://synthetic.new/).

```env
SYNTHETIC_API_KEY=your-synthetic-api-key-here
```

Optionally pin a model:

```env
SYNTHETIC_DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4
```

#### Provider B: MiniMax

```env
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your-minimax-api-key-here
MINIMAX_DEFAULT_MODEL=MiniMax-M2.5
```

#### Provider C: Any OpenAI-compatible API

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://your-provider.com/v1
LLM_API_KEY=your-api-key-here
OPENAI_COMPATIBLE_DEFAULT_MODEL=your-model-name
```

---

### Step 3 — Discover available models

```bash
node --experimental-strip-types src/cli.ts list-models
```

Copy a model name you want to use and set it as your default:

```env
DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4
```

---

### Step 4 — Link the CLI globally

This installs `jarvis` as a system-wide command:

```bash
npm link
```

After linking, you can run `jarvis` from any directory:

```bash
jarvis --version
jarvis --help
```

To unlink later: `npm unlink -g jarvis`

> **Note:** If you prefer not to link globally, run `node --experimental-strip-types src/cli.ts` or `./bin/jarvis` from the project directory instead of `jarvis`.

---

### Step 5 — Run your first chat

```bash
jarvis chat "Hello! Can you introduce yourself?"
```

Or with tool calling enabled (Jarvis can read files, search code, run commands):

```bash
jarvis chat-with-tools "What files are in the current directory?"
```

---

## Telegram Bot Setup (optional)

Jarvis can run as a Telegram bot for persistent, mobile-accessible chat.

### Step 1 — Create a bot with BotFather

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token you receive

### Step 2 — Configure the token

Add to your `.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

### Step 3 — Restrict access (recommended)

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot), then:

```env
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Multiple users: `TELEGRAM_ALLOWED_USER_IDS=123456789,987654321`

### Step 4 — Start the bot

```bash
# Telegram-only mode
jarvis telegram

# Or as a full service (Telegram + HTTP + cron)
jarvis serve
```

---

## Running as a Background Service

To keep Jarvis running persistently:

### Using `pm2` (recommended)

```bash
npm install -g pm2
pm2 start "jarvis serve" --name jarvis
pm2 save
pm2 startup   # Follow printed instructions to auto-start on reboot
```

Monitor with:

```bash
pm2 logs jarvis
pm2 status
```

### Using a shell script

```bash
nohup jarvis serve >> jarvis.log 2>&1 &
echo "Jarvis PID: $!"
```

---

## Logging

Enable file logging to persist logs across restarts:

```env
JARVIS_LOG_FILE=./jarvis.log
JARVIS_LOG_LEVEL=info
```

View logs in real time:

```bash
tail -f jarvis.log
```

View only errors:

```bash
cat jarvis.log | grep '"level":50'
```

When `JARVIS_LOG_FILE` is set, the `read_logs` introspection tool becomes available for Jarvis to self-diagnose from its own logs.

---

## Advanced Configuration

All configuration can be set via environment variables. See `.env.example` for the full list with defaults.

Key settings:

| Variable | Default | Description |
|---|---|---|
| `JARVIS_MEMORY_DIR` | `~/.jarvis` | Where memory database is stored |
| `JARVIS_LOG_LEVEL` | `info` | Log verbosity (`debug`/`info`/`warn`/`error`/`silent`) |
| `JARVIS_LOG_FILE` | _(none)_ | Log file path (enables `read_logs` tool) |
| `JARVIS_TOOLS_MAX_ITERATIONS` | `5` | Max tool calls per LLM turn |
| `JARVIS_TOOLS_MAX_PARALLEL` | `5` | Max parallel tool executions |
| `JARVIS_TOOLS_TIMEOUT_MS` | `120000` | Tool timeout (milliseconds) |
| `JARVIS_TOOLS_EVENT_STORE_SIZE` | `500` | In-memory telemetry ring buffer size |

For a complete reference, see `.env.example`.

---

## Verifying the Installation

Run through this checklist:

```bash
# 1. CLI responds
jarvis --version

# 2. Config loads without errors
jarvis list-models

# 3. Basic chat works
jarvis chat "Say hello"

# 4. Tool calling works
jarvis chat-with-tools "List files in the current directory"

# 5. Memory works
jarvis memory stats

# 6. Tests pass (development only)
npm test
```

---

## Troubleshooting

### `jarvis: command not found`

The global link isn't set up. Either:
- Run `npm link` from the project directory, or
- Use `node --experimental-strip-types src/cli.ts` instead

### `Error: Model is required`

`DEFAULT_MODEL` is not set. Either:
- Add `DEFAULT_MODEL=<model-name>` to `.env`, or
- Pass it per-command: `jarvis chat -m "hf:model-name" "hello"`

Run `jarvis list-models` to see available models.

### `Error: API key not configured`

Your `SYNTHETIC_API_KEY` (or provider-specific key) is missing or empty in `.env`.

### Node.js version errors

Jarvis requires Node.js v22+. Check with `node --version`. Upgrade via [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`.

### `.env` not created automatically

Run `npm run setup` to copy `.env.example` → `.env` manually:

```bash
npm run setup
```

### Memory worker errors

The SQLite memory worker auto-respawns on crash. If it keeps crashing, check:

```bash
jarvis memory stats
```

If the memory database is corrupted, remove it and let it recreate:

```bash
rm -rf ~/.jarvis/memory.db
```

### Tool timeouts

Increase the timeout in `.env`:

```env
JARVIS_TOOLS_TIMEOUT_MS=300000
```

---

## Uninstalling

```bash
# Remove global link
npm unlink -g jarvis

# Remove memory database (optional)
rm -rf ~/.jarvis

# Remove the project
cd .. && rm -rf jarvis
```

---

## What's Next

- Read the [README](./README.md) for an overview of all commands and capabilities
- See [CONFIG_SYSTEM.md](./CONFIG_SYSTEM.md) for detailed configuration documentation
- See [docs/decisions.md](./docs/decisions.md) for architecture decisions
