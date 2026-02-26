import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { createSkillRegistry, parseSkillFrontmatter } from './index.ts'

describe('skills registry', () => {
  test('parses frontmatter with inline tools list', () => {
    const parsed = parseSkillFrontmatter([
      '---',
      'name: planner',
      'description: Plan complex work',
      'tools: [read, glob, todo_list]',
      '---',
      '',
      '## Usage',
    ].join('\n'), 'data/skills/planner.md')

    assert.equal(parsed.name, 'planner')
    assert.equal(parsed.description, 'Plan complex work')
    assert.deepEqual(parsed.tools, ['read', 'glob', 'todo_list'])
  })

  test('reloads custom skills and protects builtin names', async () => {
    const tempDir = await mkdtemp(join(process.cwd(), '.tmp-skills-'))
    try {
      await writeFile(join(tempDir, 'focus.md'), [
        '---',
        'name: focus',
        'description: Keep responses concise',
        'tools:',
        '  - read',
        '  - edit',
        '---',
        '',
        '## Usage',
      ].join('\n'), 'utf-8')
      await writeFile(join(tempDir, 'reminder.md'), [
        '---',
        'name: reminder',
        'description: conflict with builtin',
        'tools: [read]',
        '---',
      ].join('\n'), 'utf-8')

      const registry = createSkillRegistry()
      registry.register({
        name: 'reminder',
        description: 'builtin',
        tools: ['schedule_message'],
        filePath: 'src/skills/reminder.md',
      })

      const result = await registry.reloadCustomFromDir(tempDir)
      assert.equal(result.loaded, 1)
      assert.equal(result.errors.length, 1)

      const names = registry.list().map((skill) => skill.name)
      assert.deepEqual(names.sort(), ['focus', 'reminder'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
