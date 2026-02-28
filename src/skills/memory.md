---
name: memory
description: Automatically remember user preferences, decisions, and project context across conversations — store proactively without being asked
tools:
  - memory_store
  - memory_search
  - memory_delete
---

## When to Store — Proactively, Without Being Asked

Store things automatically as they come up naturally in conversation. Do not wait for the user to say "remember this." If the information is durable and would be useful in a future conversation, store it.

**Store immediately when the user:**
- Expresses a preference or habit ("I prefer tabs over spaces", "I use fish shell", "I always deploy to Fly.io")
- States a decision or choice ("we're going with PostgreSQL", "I'm switching to bun")
- Shares project context ("this is a Node 22 project", "my API key is in .env", "the team is three people")
- Mentions a personal fact ("I'm in PST", "I'm a solo developer", "I work on this on weekends")
- Corrects you ("actually, the database is Postgres, not SQLite") — update or delete the old memory

**Do not store:**
- Transient tasks ("summarize this file", "help me fix this bug") — these are ephemeral
- Information you can look up live (file contents, current time)
- Repetitions of things you've already stored

## How to Store — Silently and Specifically

- Use `memory_store` **without announcing it** in your reply unless the user asks if you remembered something
- Write concise, specific content — one fact per memory: "User prefers TypeScript over JavaScript" not "User discussed language preferences"
- Choose the right type:
  - `preference` — how they like things done, style choices, tool choices, workflow habits
  - `fact` — project context, technical decisions, personal facts, domain knowledge
  - `conversation_summary` — only use this when explicitly asked to summarize a conversation
- Add 1–3 tags that would help find this memory later

## When to Search — Before Answering Relevant Questions

Search memory when the user's question or task might benefit from prior context you've stored:

- When starting to work on a project or codebase ("help me with my app") → `memory_search("project")`
- When the user references something you might have stored ("remember how I like X?") → `memory_search("X")`
- When giving personalized recommendations → `memory_search` for relevant preferences first
- When the user seems to assume you already know something → search before asking them to repeat themselves

`getAutoContext` already injects relevant memories automatically, but explicit searches let you pull more targeted context when needed.

## Examples

**User says**: "I always use 2-space indentation"
→ Silently call `memory_store(content="User uses 2-space indentation", type="preference", tags=["formatting","indentation"])`
→ Reply normally without mentioning the storage

**User says**: "We're building this on Deno 2, not Node"
→ Silently call `memory_store(content="Project uses Deno 2, not Node", type="fact", tags=["deno","runtime"])`
→ If you had a conflicting Node memory, delete or supersede it

**User starts**: "Help me with my Rust project"
→ First call `memory_search("rust project")` to see if you have relevant context before diving in

**User asks**: "Do you remember my preferred editor?"
→ Call `memory_search("editor preference")` and answer from results, or say you don't have it stored

## Housekeeping

- Use `memory_delete` when the user corrects outdated information
- Don't duplicate near-identical content — deduplication is automatic but still avoid redundant stores
- If the user asks what you remember about them, search and summarize — don't just recite raw memory records
