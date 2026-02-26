# Coding Agent Tool Spec

A minimal, opinionated specification for the tools a code-writing AI agent needs.

---

## Design Principles

1. **Read before write** — The agent must read a file before editing it. Prevents hallucinated edits against imagined content.
2. **Surgical edits over full rewrites** — Exact-match replacement is safer than overwriting entire files. Reduces risk of dropped content.
3. **Specialized tools over shell** — Dedicated Read/Edit/Grep tools produce structured output and are harder to misuse than raw `cat`/`sed`/`grep` through a shell.
4. **Bounded output** — All tools truncate large results. The agent can paginate if needed. Never flood the context window.
5. **Timeouts everywhere** — Every tool has a maximum execution time. No runaway processes.
6. **Least privilege** — Tools expose the minimum capability needed. The shell is powerful but should be a fallback, not the default.

---

## Tools

### 1. Read

**Intent**: See the contents of a file or directory listing.

| Field | Detail |
|---|---|
| Input | `filePath`, optional `offset` (line number), optional `limit` (max lines) |
| Output | Line-numbered file contents, or directory listing |
| Default | First 2000 lines from start of file |

**Safeguards**:
- Lines longer than 2000 chars are truncated.
- Output is capped; if exceeded, written to a temp file for paginated access.
- Works on text, images, and PDFs (returns as attachments for binary).

---

### 2. Glob

**Intent**: Find files by name or path pattern. Answers "where is this file?"

| Field | Detail |
|---|---|
| Input | `pattern` (glob, e.g. `**/*.ts`), optional `path` (search root) |
| Output | List of matching file paths, sorted by modification time |

**Safeguards**:
- Pattern-only — no file content is read.
- Results are bounded; extremely broad patterns return a truncated list.

---

### 3. Grep

**Intent**: Search file contents by regex. Answers "where is this code?"

| Field | Detail |
|---|---|
| Input | `pattern` (regex), optional `include` (file filter, e.g. `*.ts`), optional `path` |
| Output | File paths and line numbers with matches, sorted by modification time |

**Safeguards**:
- Returns locations, not full file contents — keeps output compact.
- Regex is bounded by execution timeout to prevent catastrophic backtracking.

---

### 4. Edit

**Intent**: Make surgical, exact-string replacements in a file.

| Field | Detail |
|---|---|
| Input | `filePath`, `oldString`, `newString`, optional `replaceAll` (boolean) |
| Output | Confirmation of edit |

**Safeguards**:
- **Read-first requirement**: Fails if the file hasn't been read in the current session.
- **Exact match**: `oldString` must appear verbatim. No regex, no fuzzy matching.
- **Unique match**: If `oldString` matches multiple locations, the edit fails unless `replaceAll` is true. Forces the agent to provide more surrounding context.
- **Diff-aware**: `oldString` and `newString` must differ.

---

### 5. Write

**Intent**: Create a new file or fully overwrite an existing one.

| Field | Detail |
|---|---|
| Input | `filePath` (absolute), `content` |
| Output | Confirmation |

**Safeguards**:
- **Read-first for existing files**: If the file already exists, it must have been read first.
- **Prefer Edit**: Writing should be reserved for new files or complete rewrites. Edit is preferred for modifications.
- **No accidental docs**: Agent should not proactively create README/docs files unless asked.

---

### 6. Shell (Bash)

**Intent**: Run system commands — build, test, lint, git, install dependencies, etc.

| Field | Detail |
|---|---|
| Input | `command`, optional `workdir`, optional `timeout` |
| Output | stdout/stderr of the command |
| Default timeout | 120 seconds |

**Safeguards**:
- **Persistent session**: State (env vars, working directory) carries across calls within a session.
- **Output cap**: Truncated at ~50KB or 2000 lines; full output saved to a file.
- **No file ops via shell**: Agent should not use `cat`, `sed`, `awk`, `echo >` when Read/Edit/Write tools exist.
- **Git safety**: No `--force` pushes, no `--no-verify`, no interactive flags (`-i`), no config changes unless the user explicitly requests them.
- **Path quoting**: Paths with spaces must be double-quoted.

---

### 7. AskUser

**Intent**: Get clarification, preferences, or decisions from the user before proceeding.

| Field | Detail |
|---|---|
| Input | Question text, list of options (with labels and descriptions), optional `multiple` flag |
| Output | User's selected option(s) |

**Safeguards**:
- Should be used when instructions are ambiguous, not as a crutch to avoid making decisions.
- Options should be concise and actionable.

---

### 8. TodoList

**Intent**: Plan and track multi-step tasks. Gives the user visibility into progress.

| Field | Detail |
|---|---|
| Input | List of todo items, each with `content`, `status`, `priority` |
| Statuses | `pending`, `in_progress`, `completed`, `cancelled` |

**Safeguards**:
- Only one item should be `in_progress` at a time.
- Items should be marked `completed` immediately upon finishing — no batching.
- Skip for trivial single-step tasks.

---

### 9. WebFetch

**Intent**: Retrieve content from a URL — documentation, references, API specs.

| Field | Detail |
|---|---|
| Input | `url`, optional `format` (`markdown`, `text`, `html`) |
| Output | Page content in requested format |

**Safeguards**:
- Read-only — no side effects.
- HTTP auto-upgraded to HTTPS.
- Large responses are summarized.
- Timeout capped (e.g., 120s).
- Agent must not fabricate URLs. Only use URLs from user input, tool output, or known documentation sites.

---

### 10. SubAgent (Task)

**Intent**: Delegate complex or parallel sub-tasks to a specialized agent with its own context.

| Field | Detail |
|---|---|
| Input | `prompt` (task description), `subagent_type`, optional `task_id` (to resume) |
| Output | Agent's final response |

**Safeguards**:
- Each sub-agent starts with a fresh context (unless resuming via `task_id`).
- The parent agent must summarize results for the user — sub-agent output is not directly visible.
- Use for broad exploration, not for targeted lookups (prefer Grep/Glob for those).

---

---

### 11. schedule_message / list_scheduled_messages / cancel_scheduled_message

Created via `createScheduleMessageTools()` factory in `src/tools/schedule-message.ts`. Requires `sendProactive`, `dataDir`, and `logger` at construction time. These are generic building blocks — not tied to any specific skill.

#### schedule_message

**Intent**: Schedule a text message to be delivered to the current session after a delay.

| Field | Detail |
|---|---|
| Input | `text` (string), `delay_minutes` (number, >= 1) |
| Output | Confirmation with message ID |

**Behavior**:
- Creates a timer and persists to `data/scheduled-messages.json` (atomic write)
- When the timer fires, calls `sendProactive()` to deliver the message to the originating session
- Survives process restarts — expired messages fire immediately on reload

#### list_scheduled_messages

**Intent**: Show pending scheduled messages for the current session.

| Field | Detail |
|---|---|
| Input | (none) |
| Output | List of messages with IDs, text, and time remaining |

**Behavior**:
- Filters by the calling session's ID
- Shows minutes remaining until each message delivers

#### cancel_scheduled_message

**Intent**: Cancel a pending scheduled message.

| Field | Detail |
|---|---|
| Input | `message_id` (string), optional `global` (boolean) |
| Output | Confirmation |

**Behavior**:
- By default, cancellation is scoped to the calling session
- If `global: true`, cancellation is performed by ID across sessions
- Clears the in-memory timer and removes from persistent store
- Returns error if ID not found

---

### 12. memory_search / memory_store

Created via `createMemoryTools()` using `MemoryService` (`src/memory/service.ts`) backed by SQLite + FTS5 (`~/.jarvis/memory.db` by default).

#### memory_search

**Intent**: Search stored memories by keyword with optional filters.

| Field | Detail |
|---|---|
| Input | `query` (string), optional `type`, optional `limit` (default 5, max 20) |
| Output | Compact list of matching memories with metadata (type/date/rank/tags) |

**Behavior**:
- Empty query falls back to recent memories
- Results are bounded (default 5, hard max 20)
- Uses FTS5 matching with compact output formatting

#### memory_store

**Intent**: Persist a typed memory for future recall.

| Field | Detail |
|---|---|
| Input | `content` (string), `type` (preference/fact/conversation_summary), optional `tags` (string[]) |
| Output | Confirmation (stored or deduplicated existing memory) |

**Behavior**:
- Validates non-empty content, allowed type, and tag shape
- Deduplicates near-exact memory content
- Stores estimated token count for budgeting/retrieval

---

## Skills

Skills are **markdown instruction files** that teach the agent how to combine tools for higher-level tasks. They do not define or own tools — if a skill needs a new capability, it's added as a regular tool.

Each skill file (`src/skills/<name>.md`) has two parts:
1. **Frontmatter** — YAML metadata (name, description, tool names) included in every system prompt
2. **Body** — Detailed usage guide, examples, and edge cases. The agent loads this on demand via the `read` tool when it needs to understand a skill deeply.

The skill registry reads frontmatter at startup and builds a compact block for the system prompt:
```
Available skills (use `read` tool on the skill file for detailed instructions):
- reminder (src/skills/reminder.md): Set, list, and cancel time-based reminders
  Tools: schedule_message, list_scheduled_messages, cancel_scheduled_message
```

---

## Tool Selection Heuristic

```
Need to find a file by name?          -> Glob
Need to find code by content?         -> Grep
Need to understand a file?            -> Read
Need to change a few lines?           -> Edit
Need to create a new file?            -> Write
Need to run a command?                -> Shell
Need to ask the user something?       -> AskUser
Need to plan a multi-step task?       -> TodoList
Need to look something up online?     -> WebFetch
Need to do something complex/broad?   -> SubAgent
Need to schedule a delayed message?   -> schedule_message
Need to recall/store durable knowledge? -> memory_search / memory_store
```

---

## What's Intentionally Excluded

- **File delete** — Too destructive. Use Shell + git to recover if needed.
- **File move/rename** — Use Shell (`mv`, `git mv`). Not common enough to warrant a dedicated tool.
- **Regex-based edit** — Too error-prone for agents. Exact-match is safer.
- **Interactive terminal** — Agents can't handle interactive prompts (`vim`, `less`, `git rebase -i`). All commands must be non-interactive.
- **Network requests with side effects** — No POST/PUT/DELETE. WebFetch is read-only. Use Shell + `curl` when the user explicitly needs it.
