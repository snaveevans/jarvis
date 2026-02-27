# AGENTS.md - Development Guidelines

## Project Overview

Jarvis is a Node.js + TypeScript AI assistant project. It provides an LLM client wrapper around OpenAI-compatible APIs (synthetic.new) with tool calling capabilities.

**Runtime**: Node.js v22+ with a `tsc` build step (`npm run build` compiles `src/` → `dist/`). Dev mode uses `--experimental-strip-types` for direct TS execution.

## Project Structure

```
src/
├── cli.ts                 # Main CLI entry point (Commander.js)
├── dispatcher.ts          # Central coordinator (sessions, tools, skills)
├── config.ts              # Configuration loader (c12 + Zod validation)
├── logger.ts              # Centralized logging (pino)
├── prompt-input.ts        # Prompt input handling
├── commands/
│   ├── uninstall.ts       # Uninstall command
│   └── update.ts          # Update command
├── endpoints/
│   ├── index.ts           # Endpoint exports
│   ├── types.ts           # Endpoint, EndpointProfile, InboundMessage, OutboundMessage
│   ├── cli.ts             # CLI endpoint (stdout)
│   └── telegram.ts        # Telegram endpoint (grammy)
├── llm/
│   ├── client.ts          # LLMClient - OpenAI SDK wrapper
│   ├── chat-with-tools.ts # Tool execution orchestration (parallel, supports dynamic tools)
│   ├── provider.ts        # Provider abstraction and selection
│   ├── types.ts           # TypeScript interfaces
│   ├── errors.ts          # Custom error classes
│   ├── index.ts           # Public exports
│   └── *.test.ts          # Unit tests
├── tools/
│   ├── types.ts           # Tool type definitions (+ ToolExecutionContext)
│   ├── common.ts          # Shared safety and output helpers
│   ├── index.ts           # Base tool registry and execution
│   ├── read.ts            # Read tool (files/directories)
│   ├── glob.ts            # File path pattern search (delegates to search pool)
│   ├── grep.ts            # Content regex search (delegates to search pool)
│   ├── edit.ts            # Exact-match surgical edits
│   ├── write.ts           # File creation/overwrite
│   ├── shell.ts           # Guarded shell execution (delegates to shell pool)
│   ├── web-fetch.ts       # Read-only web fetching
│   ├── web-search.ts      # Web search (Brave/Synthetic backends)
│   ├── ask-user.ts        # User clarification interface
│   ├── todo-list.ts       # In-session task tracking interface
│   ├── sub-agent.ts       # Sub-agent delegation interface
│   ├── read-file.ts       # Backward-compatible read_file alias
│   ├── schedule-message.ts # Generic scheduled-message tools factory (+ persistence)
│   ├── memory-tools.ts    # Memory tool factory/integrator
│   ├── memory-search.ts   # memory_search tool
│   ├── memory-store.ts    # memory_store tool
│   ├── memory-delete.ts   # memory_delete tool
│   ├── health-check.ts    # Health check endpoint
│   ├── introspect.ts      # Tool introspection
│   ├── read-logs.ts       # Log file reading
│   └── skill-manager.ts   # Skill management (create/list/remove)
├── memory/
│   ├── db.ts              # SQLite schema/migrations
│   ├── service.ts         # MemoryService (async interface, in-process implementation)
│   ├── helpers.ts         # Pure functions shared between service and worker
│   ├── eviction-evaluator.ts # Memory eviction logic
│   ├── types.ts           # Memory interfaces and enums
│   └── index.ts           # Public exports
├── sessions/
│   ├── index.ts           # Sessions module exports
│   ├── types.ts           # Session interface
│   ├── store.ts           # In-memory session store
│   └── history-store.ts   # Session history persistence (SQLite)
├── search/
│   ├── types.ts           # Search type definitions
│   └── providers/
│       ├── brave.ts       # Brave Search integration
│       └── synthetic.ts   # Synthetic Search integration
├── workers/
│   ├── memory-worker.ts       # SQLite worker thread entry point
│   ├── memory-worker-client.ts # Main thread MemoryService via worker
│   ├── search-worker.ts      # Glob/grep worker thread entry point
│   ├── search-worker-pool.ts # Round-robin search worker pool (2 workers)
│   ├── types.ts               # WorkerRequest/WorkerResponse interfaces
│   └── index.ts               # Public exports
├── shell/
│   ├── pool.ts            # Concurrency-limited shell process pool (default 3)
│   ├── types.ts           # ShellJob, ShellResult, ShellPool interfaces
│   └── index.ts           # Public exports
├── triggers/
│   └── cron.ts            # Interval-based scheduled tasks
├── telemetry/
│   └── event-store.ts     # Event telemetry ring buffer
└── skills/
    ├── types.ts           # SkillFrontmatter interface
    ├── index.ts           # SkillRegistry: reads frontmatter, builds prompt block
    ├── reminder.md        # Reminder skill instructions
    ├── memory.md          # Memory skill instructions
    └── introspection.md   # Introspection skill instructions
```

## Build/Test/Lint Commands

```bash
# Build (compile src/ → dist/)
npm run build

# Clean build output
npm run clean

# Run production CLI (requires build)
node dist/cli.js --help
bin/jarvis --help

# Run in dev mode (no build needed)
npm run dev

# Run all tests (from source, no build needed)
npm test

# Run a single test file
node --experimental-strip-types --test src/llm/client.test.ts
node --experimental-strip-types --test src/llm/types.test.ts

# Lint (once linter is configured)
# npm run lint

# Format (once formatter is configured)
# npm run format
```

## CLI Usage

### Setup

Copy `.env.example` to `.env` and configure your provider:

```bash
cp .env.example .env
# Edit .env — set LLM_PROVIDER, API key, and DEFAULT_MODEL
```

### Commands

```bash
# Get help
jarvis --help

# Chat with the LLM
jarvis chat "What is the capital of France?"
jarvis chat "Explain quantum computing" --stream
jarvis chat "Write a poem" -m "hf:model-name" -t 0.9
jarvis chat "Hello" --max-tokens 50
jarvis chat --file ./prompt.txt

# Chat with tool calling
jarvis chat-with-tools "Read README.md and summarize it"
jarvis chat-with-tools "What does package.json contain?"
jarvis chat-with-tools --file ./prompt.txt

# List available models
jarvis list-models
jarvis list-models --json
```

## Code Style Guidelines

### TypeScript

- Use strict TypeScript configuration
- Prefer explicit types over implicit inference for function parameters and return types
- Use `interface` for object shapes, `type` for unions/complex types
- Avoid `any`; use `unknown` with type guards when type is uncertain
- Use type imports for types: `import type { Foo } from './types.ts'`

### Imports

- Use ES modules (`import/export`) exclusively
- Group imports in this order:
  1. External libraries (e.g., `openai`, `commander`)
  2. Internal modules (e.g., `./client.ts`)
  3. Type imports (e.g., `import type { Foo }`)
- Use `.ts` extension in imports: `import { Foo } from './foo.ts'`
- Prefer named imports over default imports

**Example:**
```typescript
import { Command } from 'commander'
import { readFile } from 'node:fs/promises'

import { LLMClient } from './client.ts'
import { executeTool } from '../tools/index.ts'

import type { ChatMessage } from './types.ts'
```

### Formatting

- 2 spaces for indentation
- Single quotes for strings
- No semicolons (ASI-friendly code)
- 100 character line limit
- Trailing commas in multi-line objects/arrays
- Use `const` by default, `let` when reassignment needed

### Naming Conventions

- **Files**: kebab-case.ts for modules (e.g., `read-file.ts`, `chat-with-tools.ts`)
- **Variables/functions**: camelCase (e.g., `defaultModel`, `executeTool`)
- **Classes/interfaces**: PascalCase (e.g., `LLMClient`, `ChatMessage`)
- **Constants**: UPPER_SNAKE_CASE for true constants (e.g., `BASE_URL`)
- **Types**: PascalCase with descriptive names (e.g., `UserServiceConfig`)
- **Private members**: prefixed with underscore `_privateMethod()`
- **Error classes**: PascalCase with Error suffix (e.g., `LLMRateLimitError`)

### Error Handling

- Use custom error classes extending `Error`
- Always include descriptive error messages
- Use early returns to reduce nesting
- Handle async errors with try/catch; avoid floating promises
- Log errors with context before re-throwing
- Map external errors (e.g., OpenAI SDK) to our error types

**Example:**
```typescript
export class LLMError extends Error {
  readonly code: string
  readonly statusCode?: number

  constructor(message: string, code: string, statusCode?: number) {
    super(message)
    this.name = 'LLMError'
    this.code = code
    this.statusCode = statusCode
  }
}
```

### Architecture

- Prefer functional programming patterns
- Keep functions small and focused (single responsibility)
- Use dependency injection for testability
- Separate I/O from business logic
- Favor immutability (const, readonly, spread operator)
- Export types and functions from index.ts files

### Testing

- Use Node.js native test runner (`node:test` and `node:assert`)
- Name test files with `.test.ts` suffix (e.g., `client.test.ts`)
- Use `describe` for grouping related tests
- Use `test` for individual test cases
- Test both success and error paths
- Mock external dependencies when testing business logic

**Example:**
```typescript
import { test, describe } from 'node:test'
import assert from 'node:assert'

describe('Component', () => {
  test('does something correctly', () => {
    const result = doSomething()
    assert.equal(result, expected)
  })
})
```

## Development Workflow

1. Check `docs/decisions.md` before making architectural changes
2. Follow `docs/tool-spec.md` when adding or changing tool capabilities/safeguards
3. Write code incrementally with fast feedback loops
4. Add tests for new functionality
5. Update this file when adding new tooling
6. Commit with conventional commit messages (e.g., `feat:`, `fix:`, `docs:`)

## Build & Runtime

- **Production**: `npm run build` compiles `src/` → `dist/` via `tsc`. `bin/jarvis` runs `node dist/cli.js`.
- **Dev mode**: `npm run dev` runs `node --experimental-strip-types src/cli.ts` (no build needed).
- **Tests**: `npm test` runs from source via `--experimental-strip-types` (no build needed).
- Source files use `.ts` import extensions; `rewriteRelativeImportExtensions` rewrites them to `.js` in compiled output.
- Worker threads auto-detect compiled vs source mode and adjust paths/execArgv accordingly.
- Parameter properties are NOT supported (don't use `constructor(public readonly foo: string)`).

## Key Architecture Notes

- `src/cli.ts` is the executable entrypoint (`jarvis`) and command router (Commander). It loads `.env`, parses CLI flags, and calls into the LLM layer. In `serve`/`telegram` modes it creates extra tools (reminder), registers skill metadata, and passes both to the dispatcher.
- `src/dispatcher.ts` is the central coordinator: resolves sessions, builds system prompts (including skill prompt block), merges base + extra tools, threads `ToolExecutionContext` per request, and routes responses back through endpoints.
- `src/config.ts` loads configuration via `c12` with Zod validation. Merges `.config/default.json`, environment-specific overrides, environment variables, and CLI flags.
- `src/llm/client.ts` wraps the OpenAI SDK against the active provider's endpoint. `src/llm/provider.ts` handles provider selection and configuration resolution.
- `src/llm/chat-with-tools.ts` runs the tool-calling loop: send tool defs, execute returned tool calls in parallel (via `Promise.allSettled` with configurable `maxParallelTools`, default 5), append tool outputs, and continue up to `MAX_TOOL_ITERATIONS` (20). Provides progressive warnings at 75% and 90% of limit, and shows tool summary when limit is reached.
- `src/endpoints/` defines the endpoint abstraction. Each endpoint (CLI, Telegram) declares a profile (max message length, tone, formatting) that shapes the system prompt.
- `src/sessions/` manages per-endpoint+user conversation history with optional SQLite-backed persistence for restart recovery.
- `src/search/providers/` implements web search backends (Brave, Synthetic) used by the `web_search` tool.
- `src/tools/index.ts` is the base tool registry/dispatcher. Tools accept an optional `ToolExecutionContext` with `sessionId`, `endpointKind`, `searchPool`, and `shellPool`.
- `src/workers/` contains worker thread infrastructure. Memory worker runs SQLite off the main thread; search worker pool handles glob/grep via 2 round-robin workers.
- `src/shell/pool.ts` provides `createShellPool()` — a concurrency-limited process pool (default 3 concurrent) that queues excess shell commands.
- `src/skills/index.ts` is the skill registry. Skills are pure markdown instruction files — they don't own tools.
- Tool data is persisted to the `data/` directory (gitignored). Use atomic writes (tmp+rename).

## Key Conventions

- Use ESM imports with explicit `.ts` extensions throughout `src/**`.
- Tool-call arguments are JSON strings parsed in `executeTool`; tool handlers return `{ content, error? }` instead of throwing.
- Tests use Node's native test runner (`node:test` + `node:assert`) with files colocated as `*.test.ts`.
- Skills are markdown files in `src/skills/<name>.md` with YAML frontmatter (name, description, tool list) + a usage guide body.
- Tools that need services are created via factory functions and passed to the dispatcher as `extraTools`.
- For architecture-level decisions, use and update `docs/decisions.md`.
