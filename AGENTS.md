# AGENTS.md - Development Guidelines

## Project Overview

Jarvis is a Node.js + TypeScript AI assistant project using native TypeScript execution (no build step required).

**Runtime**: Node.js v22+ with `--experimental-strip-types`

## Build/Test/Lint Commands

```bash
# Run TypeScript files directly (native execution)
node --experimental-strip-types src/index.ts

# Run all tests
npm test

# Run a single test file
node --experimental-strip-types --test src/path/to/file.test.ts

# Lint (once linter is configured)
# npm run lint

# Format (once formatter is configured)
# npm run format
```

## Code Style Guidelines

### TypeScript

- Use strict TypeScript configuration
- Prefer explicit types over implicit inference for function parameters and return types
- Use `interface` for object shapes, `type` for unions/complex types
- Avoid `any`; use `unknown` with type guards when type is uncertain

### Imports

- Use ES modules (`import/export`) exclusively
- Group imports: 1) external libraries, 2) internal modules, 3) types
- Use absolute imports with path aliases once configured
- Prefer named imports over default imports

### Formatting

- 2 spaces for indentation
- Single quotes for strings
- No semicolons (ASI-friendly code)
- 100 character line limit
- Trailing commas in multi-line objects/arrays

### Naming Conventions

- **Files**: kebab-case.ts for modules, PascalCase.ts for classes
- **Variables/functions**: camelCase
- **Classes/interfaces**: PascalCase
- **Constants**: UPPER_SNAKE_CASE for true constants
- **Types**: PascalCase with descriptive names (e.g., `UserServiceConfig`)
- **Private members**: prefixed with underscore `_privateMethod()`

### Error Handling

- Use custom error classes extending `Error`
- Always include descriptive error messages
- Use early returns to reduce nesting
- Handle async errors with try/catch; avoid floating promises
- Log errors with context before re-throwing

### Architecture

- Prefer functional programming patterns
- Keep functions small and focused (single responsibility)
- Use dependency injection for testability
- Separate I/O from business logic
- Favor immutability (const, readonly, spread operator)

## Development Workflow

1. Check `docs/decisions.md` before making architectural changes
2. Write code incrementally with fast feedback loops
3. Add tests for new functionality
4. Update this file when adding new tooling

## Node.js Native TypeScript

- Execute: `node --experimental-strip-types file.ts`
- Shebang: `#!/usr/bin/env node --experimental-strip-types`
- No compilation step needed - types are stripped at runtime
- Type errors won't prevent execution; use IDE/editor for type checking
