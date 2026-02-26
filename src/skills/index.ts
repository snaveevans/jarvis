import type { SkillFrontmatter } from './types.ts'

export interface SkillRegistry {
  register(skill: SkillFrontmatter): void
  getSystemPromptBlock(): string
}

export function createSkillRegistry(): SkillRegistry {
  const skills: SkillFrontmatter[] = []

  return {
    register(skill: SkillFrontmatter): void {
      skills.push(skill)
    },

    getSystemPromptBlock(): string {
      if (skills.length === 0) return ''

      const lines: string[] = [
        'Available skills (use `read` tool on the skill file for detailed instructions):',
      ]

      for (const skill of skills) {
        lines.push(`- ${skill.name} (${skill.filePath}): ${skill.description}`)
        lines.push(`  Tools: ${skill.tools.join(', ')}`)
      }

      return lines.join('\n')
    },
  }
}

export type { SkillFrontmatter } from './types.ts'
