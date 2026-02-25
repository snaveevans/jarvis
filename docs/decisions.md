# Decision Log

A lightweight log of design decisions. Brief and iterative.

## Format

Each decision follows this format:

- **Date**: YYYY-MM-DD
- **Decision**: What was decided
- **Context**: Why this choice was made
- **Consequences**: What this enables or limits

---

## Decisions

### Initial setup

- **Date**: 2025-02-25
- **Decision**: Use lightweight decision log instead of formal ADRs
- **Context**: Moving fast and learning; formal ADRs would slow us down
- **Consequences**: Good for capturing intent, may need conversion to full ADR if project scales significantly

### Language and Ecosystem

- **Date**: 2025-02-25
- **Decision**: Use Node.js + TypeScript (native execution via `--loader` or `.mjs`)
- **Context**: Latest Node with native TypeScript support. Types aid intent and understanding. npm ecosystem is extensive. No compilation step needed since Jarvis will write its own code.
- **Consequences**: Fast iteration, type safety without build step, but requires recent Node version