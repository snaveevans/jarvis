import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type { SkillFrontmatter } from './types.ts'

export type SkillSource = 'builtin' | 'custom'

export interface SkillRecord extends SkillFrontmatter {
  source: SkillSource
}

export interface ReloadSkillsResult {
  loaded: number
  errors: string[]
}

export interface SkillRegistry {
  register(skill: SkillFrontmatter, source?: SkillSource): void
  list(): SkillRecord[]
  isBuiltin(name: string): boolean
  reloadCustomFromDir(skillsDir: string): Promise<ReloadSkillsResult>
  getSystemPromptBlock(): string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseToolsInline(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return trimmed ? [unquote(trimmed)] : []
  }
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((part) => unquote(part))
    .map((part) => part.trim())
    .filter(Boolean)
}

export function parseSkillFrontmatter(content: string, filePath: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  if (!match) {
    throw new Error(`Skill file missing frontmatter: ${filePath}`)
  }

  let name = ''
  let description = ''
  const tools: string[] = []
  const lines = match[1].split('\n')
  let inToolsBlock = false

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue

    const listItem = line.match(/^\s*-\s*(.+)$/)
    if (inToolsBlock && listItem) {
      const tool = unquote(listItem[1]).trim()
      if (tool) tools.push(tool)
      continue
    }
    inToolsBlock = false

    const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)\s*$/)
    if (!kv) continue
    const key = kv[1]
    const value = kv[2]

    if (key === 'name') {
      name = unquote(value)
      continue
    }
    if (key === 'description') {
      description = unquote(value)
      continue
    }
    if (key === 'tools') {
      if (!value.trim()) {
        inToolsBlock = true
      } else {
        tools.push(...parseToolsInline(value))
      }
    }
  }

  if (!name.trim()) {
    throw new Error(`Skill frontmatter missing name: ${filePath}`)
  }
  if (!description.trim()) {
    throw new Error(`Skill frontmatter missing description: ${filePath}`)
  }
  if (tools.length === 0) {
    throw new Error(`Skill frontmatter missing tools: ${filePath}`)
  }

  return {
    name: name.trim(),
    description: description.trim(),
    tools: Array.from(new Set(tools.map((tool) => tool.trim()).filter(Boolean))),
    filePath,
  }
}

function toWorkspaceRelativePath(absolutePath: string): string {
  const relative = path.relative(process.cwd(), absolutePath)
  return relative.split(path.sep).join('/')
}

export function createSkillRegistry(): SkillRegistry {
  const skills = new Map<string, SkillRecord>()

  return {
    register(skill: SkillFrontmatter, source: SkillSource = 'builtin'): void {
      skills.set(skill.name, { ...skill, source })
    },

    list(): SkillRecord[] {
      return Array.from(skills.values()).sort((a, b) => a.name.localeCompare(b.name))
    },

    isBuiltin(name: string): boolean {
      return skills.get(name)?.source === 'builtin'
    },

    async reloadCustomFromDir(skillsDir: string): Promise<ReloadSkillsResult> {
      for (const [name, skill] of skills.entries()) {
        if (skill.source === 'custom') {
          skills.delete(name)
        }
      }

      const errors: string[] = []
      let entries: string[] = []

      try {
        entries = await readdir(skillsDir)
      } catch {
        return { loaded: 0, errors }
      }

      const markdownFiles = entries.filter((entry) => entry.endsWith('.md'))
      let loaded = 0
      for (const fileName of markdownFiles) {
        const absolutePath = path.join(skillsDir, fileName)
        try {
          const content = await readFile(absolutePath, 'utf-8')
          const parsed = parseSkillFrontmatter(content, toWorkspaceRelativePath(absolutePath))
          if (this.isBuiltin(parsed.name)) {
            errors.push(`Custom skill "${parsed.name}" conflicts with built-in skill name`)
            continue
          }
          this.register(parsed, 'custom')
          loaded++
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }

      return { loaded, errors }
    },

    getSystemPromptBlock(): string {
      if (skills.size === 0) return ''

      const lines: string[] = [
        'Available skills (use `read` tool on the skill file for detailed instructions):',
      ]

      for (const skill of this.list()) {
        lines.push(`- ${skill.name} (${skill.filePath}): ${skill.description}`)
        lines.push(`  Tools: ${skill.tools.join(', ')}`)
      }

      return lines.join('\n')
    },
  }
}

export type { SkillFrontmatter } from './types.ts'
