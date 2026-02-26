import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { createSkillRegistry } from '../skills/index.ts'
import { createSkillManagerTools } from './skill-manager.ts'

describe('skill manager tools', () => {
  test('create/list/remove custom skill lifecycle', async () => {
    const tempDir = await mkdtemp(join(process.cwd(), '.tmp-skill-tools-'))
    try {
      const registry = createSkillRegistry()
      registry.register({
        name: 'introspection',
        description: 'builtin',
        tools: ['read'],
        filePath: 'src/skills/introspection.md',
      })

      const tools = createSkillManagerTools({
        skillRegistry: registry,
        skillsDir: tempDir,
        allowedToolNames: ['read', 'glob', 'edit'],
      })
      const createSkill = tools.find((tool) => tool.name === 'create_skill')
      const listSkills = tools.find((tool) => tool.name === 'list_skills')
      const removeSkill = tools.find((tool) => tool.name === 'remove_skill')

      assert.ok(createSkill)
      assert.ok(listSkills)
      assert.ok(removeSkill)

      const created = await createSkill!.execute({
        name: 'debug-flow',
        description: 'Debug recurring failures',
        tools: ['read', 'glob'],
        instructions: '## Usage\nUse read and glob to inspect failures.',
      })
      assert.equal(created.error, undefined)

      const listed = await listSkills!.execute({})
      assert.equal(listed.error, undefined)
      assert.match(listed.content, /debug-flow/)
      assert.match(listed.content, /\[custom\]/)

      const removed = await removeSkill!.execute({ name: 'debug-flow' })
      assert.equal(removed.error, undefined)

      const afterRemoval = await listSkills!.execute({})
      assert.equal(afterRemoval.error, undefined)
      assert.doesNotMatch(afterRemoval.content, /debug-flow/)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects unknown tools during skill creation', async () => {
    const tempDir = await mkdtemp(join(process.cwd(), '.tmp-skill-tools-'))
    try {
      const registry = createSkillRegistry()
      const [createSkill] = createSkillManagerTools({
        skillRegistry: registry,
        skillsDir: tempDir,
        allowedToolNames: ['read'],
      })

      const result = await createSkill.execute({
        name: 'bad-skill',
        description: 'invalid',
        tools: ['shell'],
        instructions: 'body',
      })
      assert.match(result.error ?? '', /Unknown tool names/)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
