---
name: skill-builder
description: Create custom skills to extend agent capabilities with focused, reusable instructions
tools:
  - create_skill
  - list_skills
  - remove_skill
  - read
  - write
  - edit
---

## Skill-Builder Guide

Create focused, single-purpose skills that teach the agent how to perform specific tasks.

### Where to Create Skills

**ALWAYS** create custom skills in `data/skills/` directory.
- ❌ WRONG: `./skills/my-skill.md` (repo root)
- ✅ CORRECT: `data/skills/my-skill.md`

Custom skills persist across updates and won't conflict with built-in skills in `src/skills/`.

### Skill Structure

```markdown
---
name: my-skill
description: What this skill does in one sentence
tools:
  - tool_name_1
  - tool_name_2
---

## Usage Guide

Instructions for when and how to use this skill...
```

### Naming Conventions

- Use lowercase with hyphens or underscores: `my-skill`, `my_skill`
- 2-64 characters
- Must start with letter or number
- Must be unique (check with `list_skills` first)

### Tool Selection Principles

1. **Minimal but complete**: Include only tools the skill actually needs
2. **Prefer specific over generic**: Use `read` over `shell cat`
3. **Avoid overlapping tools**: Don't include both `shell` and specialized file tools

Good tool lists:
- `read`, `edit`, `write` - for code modification skills
- `glob`, `read` - for file discovery skills
- `web_search`, `web_fetch` - for research skills

Bad tool lists:
- `shell`, `read`, `edit`, `write` (redundant - prefer specialized tools)
- Every available tool (unfocused, confusing)

### Instructions Best Practices

**Be specific and actionable:**
- ❌ "Help with code" (too vague)
- ✅ "When user asks to refactor, first read the file, then propose changes before editing"

**Include decision logic:**
- When to use this skill vs other approaches
- What information to gather first
- How to handle common errors

**Keep it focused:**
- One skill = one responsibility
- If instructions are getting long, split into multiple skills
- 50-200 lines of instructions is usually sufficient

### Testing Your Skill

After creating a skill:
1. Run `list_skills` to verify it appears
2. Test it with a real task
3. Iterate based on results
4. Use `remove_skill` if it needs major rework

### Examples

**Good skill:** `git-helper`
```yaml
name: git-helper
description: Execute git workflows (commit, branch, rebase, etc.) with proper verification
tools:
  - shell
  - read
```
Instructions explain: check status first, create commits with meaningful messages, verify operations succeeded.

**Bad skill:** `dev-tools`
```yaml
name: dev-tools
description: Help with development
tools: [all 20+ tools listed]
```
Too broad, includes unnecessary tools, vague description.

### Conflict Resolution

If a custom skill name conflicts with a built-in skill:
- The custom skill will be rejected on reload
- Rename your skill and recreate it
- Use `list_skills` to see existing names

### Workflow

1. Plan: What specific task should this skill handle?
2. Design: Which tools are essential? What's the decision flow?
3. Create: Use `create_skill` with proper frontmatter
4. Test: Verify it appears in `list_skills` and works correctly
5. Refine: Remove and recreate if needed
