# AGENTS.md - Development Guidelines

## Project Overview

Jarvis is a Node.js + TypeScript AI assistant project using native TypeScript execution (no build step required). It provides an LLM client wrapper around OpenAI-compatible APIs (synthetic.new) with tool calling capabilities.

**Runtime**: Node.js v22+ with `--experimental-strip-types`

## Project Structure

```
src/
├── cli.ts                 # Main CLI entry point (Commander.js)
├── llm/
│   ├── client.ts          # LLMClient - OpenAI SDK wrapper
│   ├── chat-with-tools.ts # Tool execution orchestration
│   ├── types.ts           # TypeScript interfaces
│   ├── errors.ts          # Custom error classes
│   ├── index.ts           # Public exports
│   └── *.test.ts          # Unit tests
└── tools/
    ├── types.ts           # Tool type definitions
    ├── common.ts          # Shared safety and output helpers
    ├── read.ts            # Read tool (files/directories)
    ├── glob.ts            # File path pattern search
    ├── grep.ts            # Content regex search
    ├── edit.ts            # Exact-match surgical edits
    ├── write.ts           # File creation/overwrite
    ├── shell.ts           # Guarded shell execution
    ├── web-fetch.ts       # Read-only web fetching
    ├── ask-user.ts        # User clarification interface
    ├── todo-list.ts       # In-session task tracking interface
    ├── sub-agent.ts       # Sub-agent delegation interface
    ├── read-file.ts       # Backward-compatible read_file alias
    └── index.ts           # Tool registry and execution
```

## Build/Test/Lint Commands

```bash
# Run TypeScript files directly (native execution)
node --experimental-strip-types src/index.ts
node --experimental-strip-types src/cli.ts --help

# Run all tests
npm test

# Run a single test file
node --experimental-strip-types --test src/llm/client.test.ts
node --experimental-strip-types --test src/llm/types.test.ts

# Run specific test by pattern (not supported natively, run full file)
node --experimental-strip-types --test src/llm/client.test.ts

# Lint (once linter is configured)
# npm run lint

# Format (once formatter is configured)
# npm run format
```

## CLI Usage

### Setup

Copy `.env.example` to `.env` and add your API key:

```bash
cp .env.example .env
# Edit .env and add your SYNTHETIC_API_KEY and DEFAULT_MODEL
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

# Chat with tool calling (read_file)
jarvis chat-with-tools "Read README.md and summarize it"
jarvis chat-with-tools "What does package.json contain?"

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

## Node.js Native TypeScript

- Execute: `node --experimental-strip-types file.ts`
- Shebang: `#!/usr/bin/env node --experimental-strip-types`
- No compilation step needed - types are stripped at runtime
- Type errors won't prevent execution; use IDE/editor for type checking
- Parameter properties are NOT supported (don't use `constructor(public readonly foo: string)`)

## Copilot Session Instructions (Merged)

### Build, test, and lint commands

Jarvis runs TypeScript directly in Node.js (no build step).

```bash
# CLI smoke check
node --experimental-strip-types src/cli.ts --help

# Full test suite
npm test

# Run one test file
node --experimental-strip-types --test src/llm/client.test.ts
node --experimental-strip-types --test src/llm/types.test.ts
```

There is currently no lint script in `package.json`.

### High-level architecture

- `src/cli.ts` is the executable entrypoint (`jarvis`) and command router (Commander). It loads `.env`, parses CLI flags, and calls into the LLM layer.
- `src/llm/client.ts` wraps the OpenAI SDK against synthetic.new's OpenAI-compatible endpoint and maps SDK/API failures into local typed errors in `src/llm/errors.ts`.
- `src/llm/chat-with-tools.ts` runs the tool-calling loop: send tool defs, execute returned tool calls, append tool outputs, and continue up to `MAX_TOOL_ITERATIONS` (5).
- `src/tools/index.ts` is the tool registry/dispatcher. `availableTools` drives `getToolDefinitions()` and `executeTool()`.
- `src/tools/read-file.ts` is the current concrete tool implementation; it follows the `Tool` contract from `src/tools/types.ts`.
- `src/llm/types.ts` holds shared message/request/response and tool schemas used by CLI, client, and tool orchestration; `src/llm/index.ts` is the public export surface.

### Key repository conventions

- Runtime is Node.js v22+ with `--experimental-strip-types`, including the shebang in `src/cli.ts`.
- Use ESM imports with explicit `.ts` extensions throughout `src/**`.
- `chat` and `chat-with-tools` require a model via `--model` or `DEFAULT_MODEL`; `LLMClient` requires `SYNTHETIC_API_KEY` unless passed in programmatically.
- Tool-call arguments are JSON strings (`call.function.arguments`) and are parsed in `executeTool`; tool handlers return `{ content, error? }` instead of throwing through the loop.
- Tests use Node's native test runner (`node:test` + `node:assert`) with files colocated as `*.test.ts`.
- For architecture-level decisions, use and update `docs/decisions.md` (lightweight decision log format).
- Keep code changes incremental and focused, consistent with the project direction in `README.md`.
