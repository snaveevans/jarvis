---
name: self-modify
description: Safely modify own source code with build/test gates, canary validation, and auto-revert
tools:
  - self_modify_start
  - self_modify_validate
  - self_modify_promote
  - self_modify_revert
  - self_modify_status
  - read
  - edit
  - write
  - shell
---

# Self-Modification Guide

You can modify your own source code to fix bugs, add features, or improve performance. This is a powerful capability with strict safety rails.

## When to Self-Modify

**Do modify when:**
- User explicitly asks you to change your own behavior or code
- You've identified a reproducible bug in your own tools
- User requests a new tool or skill
- Performance improvements with clear benefit

**Do NOT modify when:**
- Speculative improvements with no clear user need
- Changes to protected files (supervisor, self-modify system, .env, data/)
- You're uncertain about the change — ask the user first
- Within the cooldown period after a recent modification

## Workflow

### 1. Plan and Communicate

Before starting, tell the user what you plan to change and why. Get confirmation.

### 2. Start

```
self_modify_start({ description: "Add timeout parameter to web_fetch tool" })
```

This creates a git branch. You're now in modification mode.

### 3. Make Changes

Use `read`, `edit`, and `write` tools to modify source files in `src/`. Keep changes minimal and focused.

**Rules:**
- One logical change per session
- Do NOT modify protected paths (bin/jarvis-supervisor, src/tools/self-modify.ts, src/tools/common.ts, .env, .config/, data/)
- Write or update tests for any new logic
- Follow existing code patterns and style

### 4. Validate

```
self_modify_validate({ commit_message: "feat: add timeout parameter to web_fetch" })
```

This will:
1. Check for protected path violations
2. Commit your changes
3. Run `npm run build` — must pass
4. Run `npm test` — must pass
5. Boot a canary process — must start cleanly

If any step fails, you'll get the error output. Fix the issue and validate again.

### 5. Promote or Revert

**If validation passes:**
```
self_modify_promote({})
```
This merges to main, rebuilds, and triggers a supervised restart.

**If you want to abandon:**
```
self_modify_revert({ reason: "Build errors too complex to fix in this session" })
```

### 6. After Restart

The supervisor restarts you with the new code. If you crash, the supervisor auto-reverts after 3 consecutive crashes.

## Safety Checklist

Before calling `self_modify_validate`, verify:
- [ ] Changes are minimal and focused on the stated goal
- [ ] No protected files were modified
- [ ] Tests cover the new/changed logic
- [ ] Code follows project style (see CLAUDE.md)

## Checking Status

```
self_modify_status({})
```

Shows current status, branch, canary state, and recent modification history.

## Error Recovery

- **Build fails**: Read the error, fix the code, validate again
- **Tests fail**: Read the test output, fix the code or test, validate again
- **Canary crashes**: Check for runtime errors (missing imports, bad config)
- **Stuck in non-idle state**: Call `self_modify_revert` with a reason
- **After crash restart**: The system auto-reverts any incomplete modifications

## Protected Paths

These files cannot be modified during self-modification (enforced at validation):
- `bin/jarvis-supervisor` — process supervisor (external safety net)
- `src/tools/self-modify.ts` — self-modification system itself
- `src/tools/common.ts` — shared safety utilities
- `.env` — secrets and configuration
- `.config/` — configuration directory
- `data/` — runtime data directory
