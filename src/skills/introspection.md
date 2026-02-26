---
name: introspection
description: Self-diagnosis using introspect, read_logs, and health_check tools
tools: [introspect, read_logs, health_check]
---

# Introspection & Self-Diagnosis

You have access to tools for inspecting your own runtime state and diagnosing issues.

## When to use `introspect`

Call `introspect` to understand your own state without requiring file access or external calls.

- **After any tool fails twice in a row**: call `introspect({ subject: "tools" })` to check for patterns — maybe a tool is consistently failing with the same error.
- **When context feels full or you're losing track**: call `introspect({ subject: "session" })` to see message count and estimated token usage.
- **After an LLM error**: call `introspect({ subject: "errors" })` to see recent error history and `introspect({ subject: "llm" })` for API call stats.
- **When asked "what happened?" or "what went wrong?"**: call `introspect({ subject: "recent" })` for a timeline of recent events.
- **Before a complex multi-step task**: call `introspect({ subject: "session" })` to assess remaining context budget.
- **For performance questions**: call `introspect({ subject: "metrics" })` to see tool latency, token rates, and error counts.
- **When unsure about config**: call `introspect({ subject: "config" })` to check the current configuration.
- **For memory-related questions**: call `introspect({ subject: "memory" })` for database stats.

## When to use `read_logs`

Call `read_logs` when you need to look at historical log entries — especially across restarts or for earlier parts of the current session.

- **After restart**: `read_logs({ level: "error", since: "1h" })` to see errors that may have caused the restart.
- **When a user reports "it was failing earlier"**: `read_logs({ grep: "tool_call", since: "1h" })`.
- **General recent activity**: `read_logs({ tail: 30 })`.
- **Finding specific errors**: `read_logs({ level: "error", since: "24h" })`.

`read_logs` only works if `JARVIS_LOG_FILE` is set. Gracefully inform the user if it isn't configured.

## When to use `health_check`

Call `health_check` when you need to verify all subsystems are working:

- **When LLM responses feel slow**: `health_check()` to measure API latency.
- **Before a task that requires memory**: include memory status in the check.
- **If the user says "nothing is working"**: call `health_check()` as a first diagnostic step.
- **To skip the network ping for a fast check**: `health_check({ checkLLM: false })`.

## Proactive self-diagnosis

If you encounter an error or unexpected behavior, always consider:
1. Was this a tool error? → `introspect({ subject: "tools" })`
2. Is my context getting full? → `introspect({ subject: "session" })`
3. Is the LLM API healthy? → `health_check()`
4. Have there been other recent errors? → `introspect({ subject: "errors" })`

Do not repeatedly retry the same failing operation without first diagnosing the issue.

## Privacy note

The `introspect` tool exposes metadata only — message counts, token estimates, latency. It never exposes message content. The API key in `config` is always masked.
