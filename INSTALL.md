# Installing Jarvis

A step-by-step guide to getting Jarvis running on your machine.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | **v22 or later** | Required for native TypeScript support |
| **npm** | v10+ | Bundled with Node.js v22 |
| **Git** | Any | To clone the repository |
| **API key** | — | Configure in [Step 2](#step-2--configure-your-api-key) |

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

## Quick Start

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/snaveevans/jarvis/main/install.sh | bash
```

This clones the repo to `~/.jarvis`, installs dependencies, builds, and adds `jarvis` to your PATH. After it completes:

```bash
# Reload your shell (or open a new terminal)
source ~/.zshrc   # or ~/.bashrc / ~/.bash_profile

# Set your API key
export SYNTHETIC_API_KEY=your-key-here
export DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4

# Verify
jarvis --version
jarvis list-models
jarvis chat "Hello!"
```

> To install to a custom location: `JARVIS_HOME=/opt/jarvis curl -fsSL ... | bash`

---

### Manual Setup (Development, with .env file)

```bash
# 1. Clone the repository
git clone <repo-url>
cd jarvis

# 2. Install dependencies
npm install

# 3. Copy .env.example and add your API key(s)
cp .env.example .env
#    Required: LLM provider key (for chat)
#    Optional but recommended: BRAVE_API_KEY (for web_search)

# 4. Test with dev script (loads .env automatically)
npm run dev list-models
npm run dev chat "Hello!"

# 5. Verify
npm run dev chat "What is the capital of France?"
```

### Manual Setup (Production, with environment variables)

```bash
# 1. Clone, install, and build
git clone <repo-url>
cd jarvis
npm install
npm run build

# 2. Link the CLI globally
npm link

# 3. Set environment variables (no .env file needed)
export SYNTHETIC_API_KEY=your-key-here
export DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4
export BRAVE_API_KEY=your-brave-key-here  # optional

# 4. Verify
jarvis --version
jarvis list-models
jarvis chat "Hello!"
```

---

## Step-by-Step Setup

Jarvis supports two deployment modes:

1. **Development Mode**: Uses `.env` file for configuration (easier for local development)
2. **Production Mode**: Uses environment variables (better for servers and containers)

Choose the mode that fits your use case.

---

### Development Mode Setup

#### Step 1 — Clone and install

```bash
git clone <repo-url>
cd jarvis
npm install
```

---

#### Step 2 — Configure your API key

Copy `.env.example` to `.env` and open it in your editor:

```bash
cp .env.example .env
```

```bash
# macOS / Linux
nano .env
# or
code .env
```

Set the required variables for your provider:

##### Provider A: Synthetic (default)

Get a key at [synthetic.new](https://synthetic.new/).

```env
SYNTHETIC_API_KEY=your-synthetic-api-key-here
```

Optionally pin a model:

```env
SYNTHETIC_DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4
```

##### Provider B: MiniMax

```env
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your-minimax-api-key-here
MINIMAX_DEFAULT_MODEL=MiniMax-M2.5
```

##### Provider C: Any OpenAI-compatible API

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://your-provider.com/v1
LLM_API_KEY=your-api-key-here
OPENAI_COMPATIBLE_DEFAULT_MODEL=your-model-name
```

#### Step 2b — Configure `web_search` backend (optional but recommended)

Jarvis now includes a `web_search` tool. You can choose the backend with:

```env
JARVIS_SEARCH_PROVIDER=brave
```

##### Option 1: Brave Search (recommended)

```env
BRAVE_API_KEY=your-brave-api-key-here
# Optional:
# BRAVE_SEARCH_BASE_URL=https://api.search.brave.com/res/v1/web/search
```

##### Option 2: Synthetic Search

```env
JARVIS_SEARCH_PROVIDER=synthetic
# Either dedicated search key:
SYNTHETIC_SEARCH_API_KEY=your-synthetic-search-key-here
# Or fallback to your existing SYNTHETIC_API_KEY
```

If `web_search` is used without a configured provider key, Jarvis returns a clear tool error.

---

#### Step 3 — Discover available models

```bash
npm run dev list-models
```

Copy a model name you want to use and set it as your default in `.env`:

```env
DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4
```

---

#### Step 4 — Run your first chat

```bash
npm run dev chat "Hello! Can you introduce yourself?"
```

Or with tool calling enabled (Jarvis can read files, search code, run commands):

```bash
npm run dev chat-with-tools "What files are in the current directory?"
```

---

### Production Mode Setup

#### Step 1 — Clone, install, and build

```bash
git clone <repo-url>
cd jarvis
npm install
npm run build
```

---

#### Step 2 — Set environment variables

Instead of using a `.env` file, export environment variables directly:

##### Provider A: Synthetic (default)

```bash
export SYNTHETIC_API_KEY=your-synthetic-api-key-here
export DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4
```

##### Provider B: MiniMax

```bash
export LLM_PROVIDER=minimax
export MINIMAX_API_KEY=your-minimax-api-key-here
export MINIMAX_DEFAULT_MODEL=MiniMax-M2.5
```

##### Provider C: Any OpenAI-compatible API

```bash
export LLM_PROVIDER=openai-compatible
export LLM_BASE_URL=https://your-provider.com/v1
export LLM_API_KEY=your-api-key-here
export OPENAI_COMPATIBLE_DEFAULT_MODEL=your-model-name
```

##### Web Search (optional)

```bash
# Brave Search (recommended)
export JARVIS_SEARCH_PROVIDER=brave
export BRAVE_API_KEY=your-brave-api-key-here

# OR Synthetic Search
export JARVIS_SEARCH_PROVIDER=synthetic
export SYNTHETIC_SEARCH_API_KEY=your-synthetic-search-key-here
```

---

#### Step 3 — Link the CLI globally

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

> **Note:** If you prefer not to link globally, you can still use `npm run dev` commands from the project directory.

---

#### Step 4 — Discover available models

```bash
jarvis list-models
```

---

#### Step 5 — Run your first chat

```bash
jarvis chat "Hello! Can you introduce yourself?"
```

Or with tool calling enabled:

```bash
jarvis chat-with-tools "What files are in the current directory?"
```

---

### Custom Skills (optional)

Jarvis can now create and manage custom skills at runtime using tools:
- `create_skill`
- `list_skills`
- `remove_skill`

Custom skills are stored in `data/skills/*.md`, loaded lazily like built-in skills, and activated without restart.

Example prompt:

```bash
# Development
npm run dev chat-with-tools "Create a skill named release-checklist that uses read, glob, and web_search to prepare release notes."

# Production
jarvis chat-with-tools "Create a skill named release-checklist that uses read, glob, and web_search to prepare release notes."
```

---

## Telegram Bot Setup (optional)

Jarvis can run as a Telegram bot for persistent, mobile-accessible chat.

### Step 1 — Create a bot with BotFather

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token you receive

### Step 2 — Configure the token

**Development mode** — Add to your `.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

**Production mode** — Export as environment variable:

```bash
export TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

### Step 3 — Restrict access (recommended)

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot), then:

**Development mode** — Add to `.env`:

```env
TELEGRAM_ALLOWED_USER_IDS=123456789
```

**Production mode** — Export as environment variable:

```bash
export TELEGRAM_ALLOWED_USER_IDS=123456789
```

Multiple users: `TELEGRAM_ALLOWED_USER_IDS=123456789,987654321`

### Step 4 — Start the bot

```bash
# Development mode
npm run dev telegram

# Production mode
jarvis telegram

# Or as a full service (Telegram + HTTP + cron)
npm run dev serve      # Development
jarvis serve           # Production
```

---

## Running as a Background Service

To keep Jarvis running persistently in production:

### Using `pm2` (recommended)

First, ensure your environment variables are set (either in `.env` for development or exported for production):

```bash
# Install pm2 globally
npm install -g pm2

# Production mode (with environment variables)
pm2 start jarvis --name jarvis -- serve

# Development mode (loads .env file)
pm2 start npm --name jarvis -- run dev serve

# Save the process list
pm2 save

# Auto-start on reboot
pm2 startup   # Follow printed instructions
```

Monitor with:

```bash
pm2 logs jarvis
pm2 status
pm2 restart jarvis
pm2 stop jarvis
```

### Using systemd (Linux)

Create `/etc/systemd/system/jarvis.service`:

```ini
[Unit]
Description=Jarvis AI Assistant
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/jarvis
Environment="SYNTHETIC_API_KEY=your-key-here"
Environment="DEFAULT_MODEL=hf:nvidia/Kimi-K2.5-NVFP4"
Environment="TELEGRAM_BOT_TOKEN=your-token-here"
ExecStart=/path/to/jarvis/bin/jarvis serve
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable jarvis
sudo systemctl start jarvis
sudo systemctl status jarvis
```

### Using a shell script

```bash
# Production mode
nohup jarvis serve >> jarvis.log 2>&1 &
echo "Jarvis PID: $!"

# Development mode
nohup npm run dev serve >> jarvis.log 2>&1 &
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
| `JARVIS_HISTORY_ENABLED` | `true` | Persist user/assistant chat turns for restart recovery |
| `JARVIS_HISTORY_DB_PATH` | `data/session-history.db` | SQLite file for persisted session history |
| `JARVIS_HISTORY_RETENTION_HOURS` | `72` | Purge window for processed historical messages |
| `JARVIS_HISTORY_REHYDRATE_MAX_MESSAGES` | `200` | Max persisted turns replayed into memory per session |
| `JARVIS_SEARCH_PROVIDER` | `brave` | `web_search` backend (`brave` or `synthetic`) |
| `BRAVE_API_KEY` | _(none)_ | Brave Search API key for `web_search` |
| `SYNTHETIC_SEARCH_API_KEY` | _(none)_ | Synthetic `/search` API key for `web_search` |
| `JARVIS_SEARCH_DEFAULT_LIMIT` | `5` | Default number of web search results |
| `JARVIS_SEARCH_MAX_LIMIT` | `10` | Hard cap for requested web search results |
| `JARVIS_SEARCH_TIMEOUT_MS` | `15000` | Timeout for web search provider calls |
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

# 5. Web search works (if configured)
jarvis chat-with-tools "Use web_search to find the latest Node.js 22 release notes"

# 6. Memory works
jarvis memory stats

# 7. Tests pass (development only)
npm test
```

---

## Troubleshooting

### `jarvis: command not found`

The global link isn't set up. Either:
- Run `npm link` from the project directory, or
- Run `bin/jarvis` directly from the project directory

### `Error: Model is required`

`DEFAULT_MODEL` is not set. Either:
- Add `DEFAULT_MODEL=<model-name>` to `.env`, or
- Pass it per-command: `jarvis chat -m "hf:model-name" "hello"`

Run `jarvis list-models` to see available models.

### `Error: API key not configured`

Your `SYNTHETIC_API_KEY` (or provider-specific key) is missing or empty in `.env`.

### `web_search` says Brave is not configured

Set:

```env
BRAVE_API_KEY=your-brave-api-key-here
```

Or switch provider:

```env
JARVIS_SEARCH_PROVIDER=synthetic
SYNTHETIC_SEARCH_API_KEY=your-synthetic-search-key-here
```

(`SYNTHETIC_API_KEY` can also be used as fallback for synthetic search.)

### Node.js version errors

Jarvis requires Node.js v22+. Check with `node --version`. Upgrade via [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`.

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
