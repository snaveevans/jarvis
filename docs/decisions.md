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

### Skills are markdown, tools are tools

- **Date**: 2026-02-25
- **Decision**: Skills are pure markdown instruction files. They do not define or own tools. If a skill needs new capabilities, those are added as regular tools in `src/tools/`.
- **Context**: The initial design had skills bundling their own tools via a `Skill` TypeScript interface. This over-complicated things — tools belong in the tool layer where they can be tested, registered, and reused independently. Skills are just instructions that teach the LLM how to combine tools for a higher-level task. A two-layer context strategy keeps the system prompt small: YAML frontmatter (name, description, tool list) is always in context; the full guide is loaded on demand via the `read` tool.
- **Consequences**: Clean separation — `src/tools/` owns all tool logic and lifecycle, `src/skills/` owns all agent instructions. Future skills just add a `.md` file and register any new tools they need. The skill registry is trivial (reads frontmatter, builds a prompt block). Trade-off: the agent must know to `read` the skill guide for edge cases, which depends on the LLM's judgment.

### ToolExecutionContext

- **Date**: 2026-02-25
- **Decision**: Add `ToolExecutionContext { sessionId, endpointKind }` as optional second parameter to `Tool.execute`
- **Context**: Tools like reminder need to know which session/endpoint a tool call came from so they can scope data and route proactive messages back correctly. Base tools ignore this parameter (backwards-compatible).
- **Consequences**: The tool interface is now context-aware without breaking existing tools. The dispatcher threads context per-request through `chatWithTools`. This opens the door for future tools that need session awareness (e.g., per-user preferences, rate limiting).

### Extra tools via factory pattern

- **Date**: 2026-02-25
- **Decision**: Tools that need services (dispatcher, logger, data dir) are created via factory functions and passed to the dispatcher as `extraTools`
- **Context**: The schedule-message tools need `sendProactive()` to deliver messages and a data directory for persistence. Rather than giving every tool access to the dispatcher via the execution context (which would bloat the interface), tools that need services are created at startup via a factory (`createScheduleMessageTools(config)`) and passed to the dispatcher as `extraTools`. The CLI manages their lifecycle (initialize/shutdown).
- **Consequences**: The dispatcher stays generic — it accepts `extraTools` without knowing what they are. Each factory returns a handle with `{ tools, initialize(), shutdown() }` for lifecycle management. The pattern scales to future tools that need system access.

### Universal building blocks over feature-specific tools

- **Date**: 2026-02-25
- **Decision**: Build generic primitive tools (`schedule_message`, `list_scheduled_messages`, `cancel_scheduled_message`) instead of feature-specific tools (`set_reminder`, `list_reminders`, `cancel_reminder`)
- **Context**: The initial design had reminder-specific tools. But "schedule a delayed message" is a universal primitive — reminders, follow-ups, timed notifications, and future skills all need it. Skills (markdown files) teach the agent how to combine primitives for specific use cases. The reminder skill just says "when the user wants a reminder, use `schedule_message` with the text prefixed by 'Reminder: '."
- **Consequences**: Fewer tools to maintain, more skills possible without new code. Future skills (daily briefings, follow-ups, habit check-ins) can reuse the same scheduling primitive with different instructions.

### Scoped-by-default cancel with explicit global override

- **Date**: 2026-02-26
- **Decision**: Keep `cancel_scheduled_message` scoped to the current session by default, and add an explicit opt-in (`global: true`) for cross-session cancellation by ID.
- **Context**: Session-scoped cancellation prevents accidental cross-thread cancellation and keeps reminder behavior predictable. In a single-user system, intentional cross-session control is still useful, so a deliberate override flag provides that capability without making it the default.
- **Consequences**: Safe defaults are preserved for skills like reminder, while power users and system-level orchestration can intentionally perform global cancellation when needed.

### Language and Ecosystem

- **Date**: 2025-02-25
- **Decision**: Use Node.js + TypeScript (native execution via `--loader` or `.mjs`)
- **Context**: Latest Node with native TypeScript support. Types aid intent and understanding. npm ecosystem is extensive. No compilation step needed since Jarvis will write its own code.
- **Consequences**: Fast iteration, type safety without build step, but requires recent Node version
