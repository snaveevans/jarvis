import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { pathExists } from './common.ts'

import type { Tool, ToolResult } from './types.ts'
import type { SkillRegistry } from '../skills/index.ts'

export interface SkillManagerToolsConfig {
  skillRegistry: SkillRegistry
  skillsDir: string
  allowedToolNames: string[]
}

const SKILL_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{1,63}$/

function toRelativePath(absPath: string): string {
  const relative = path.relative(process.cwd(), absPath)
  return relative.split(path.sep).join('/')
}

function validateSkillName(name: string): string | undefined {
  if (!name) return 'Missing required parameter: name'
  if (!SKILL_NAME_REGEX.test(name)) {
    return 'Invalid skill name. Use 2-64 chars: lowercase letters, numbers, "-" or "_".'
  }
  return undefined
}

function renderSkillMarkdown(
  name: string,
  description: string,
  tools: string[],
  instructions: string
): string {
  const toolLines = tools.map((tool) => `  - ${tool}`).join('\n')
  const body = instructions.trim() || `## Usage Guide\n\nDescribe how to use the ${name} skill here.\n`
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'tools:',
    toolLines,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

export function createSkillManagerTools(config: SkillManagerToolsConfig): Tool[] {
  const allowedToolSet = new Set(config.allowedToolNames)

  const createSkillTool: Tool = {
    name: 'create_skill',
    description: 'Create a custom skill markdown file and activate it immediately.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique skill name (lowercase, kebab/underscore).' },
        description: { type: 'string', description: 'Short skill description shown in system prompt.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool names this skill may use.' },
        instructions: { type: 'string', description: 'Skill body markdown content.' },
      },
      required: ['name', 'description', 'tools', 'instructions'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const description = typeof args.description === 'string' ? args.description.trim() : ''
      const tools = Array.isArray(args.tools) ? args.tools.filter((t): t is string => typeof t === 'string') : []
      const instructions = typeof args.instructions === 'string' ? args.instructions : ''

      const nameError = validateSkillName(name)
      if (nameError) return { content: '', error: nameError }
      if (!description) return { content: '', error: 'Missing required parameter: description' }
      if (tools.length === 0) return { content: '', error: 'Missing required parameter: tools' }
      if (config.skillRegistry.isBuiltin(name)) {
        return { content: '', error: `Cannot overwrite built-in skill: ${name}` }
      }

      const unknownTools = tools.filter((tool) => !allowedToolSet.has(tool))
      if (unknownTools.length > 0) {
        return { content: '', error: `Unknown tool names: ${unknownTools.join(', ')}` }
      }

      const filePath = path.join(config.skillsDir, `${name}.md`)
      const markdown = renderSkillMarkdown(name, description, Array.from(new Set(tools)), instructions)

      try {
        if (await pathExists(filePath)) {
          return {
            content: '',
            error: `Skill already exists: ${name}. Use remove_skill first if you want to replace it.`,
          }
        }
        await mkdir(config.skillsDir, { recursive: true })
        await writeFile(filePath, markdown, 'utf-8')
        const reload = await config.skillRegistry.reloadCustomFromDir(config.skillsDir)
        if (reload.errors.length > 0) {
          return {
            content: '',
            error: `Skill created but reload reported errors: ${reload.errors.join('; ')}`,
          }
        }
        return {
          content: `Created and activated skill "${name}" at ${toRelativePath(filePath)}.`,
        }
      } catch (error) {
        return {
          content: '',
          error: `Failed to create skill: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }

  const listSkillsTool: Tool = {
    name: 'list_skills',
    description: 'List available skills with source, file path, and allowed tools.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(): Promise<ToolResult> {
      const skills = config.skillRegistry.list()
      if (skills.length === 0) {
        return { content: 'No skills registered.' }
      }
      const lines: string[] = []
      for (const skill of skills) {
        lines.push(`- ${skill.name} [${skill.source}] (${skill.filePath})`)
        lines.push(`  ${skill.description}`)
        lines.push(`  Tools: ${skill.tools.join(', ')}`)
      }
      return { content: lines.join('\n') }
    },
  }

  const removeSkillTool: Tool = {
    name: 'remove_skill',
    description: 'Remove a custom skill and deactivate it immediately.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Custom skill name to remove.' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const nameError = validateSkillName(name)
      if (nameError) return { content: '', error: nameError }
      if (config.skillRegistry.isBuiltin(name)) {
        return { content: '', error: `Cannot remove built-in skill: ${name}` }
      }

      const filePath = path.join(config.skillsDir, `${name}.md`)
      try {
        await unlink(filePath)
      } catch (error) {
        return {
          content: '',
          error: `Failed to remove skill: ${error instanceof Error ? error.message : String(error)}`,
        }
      }

      const reload = await config.skillRegistry.reloadCustomFromDir(config.skillsDir)
      if (reload.errors.length > 0) {
        return {
          content: '',
          error: `Skill removed but reload reported errors: ${reload.errors.join('; ')}`,
        }
      }
      return { content: `Removed skill "${name}".` }
    },
  }

  return [createSkillTool, listSkillsTool, removeSkillTool]
}
