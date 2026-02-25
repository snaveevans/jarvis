import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { buildPromptInput } from '../prompt-input.ts'

describe('buildPromptInput', () => {
  test('uses message when only message is provided', async () => {
    const prompt = await buildPromptInput({
      message: 'hello world',
    })

    assert.equal(prompt, 'hello world')
  })

  test('uses file content when only file is provided', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'jarvis-prompt-'))
    const filePath = join(tempDir, 'prompt.txt')
    await writeFile(filePath, 'prompt from file', 'utf-8')

    const prompt = await buildPromptInput({
      filePath,
    })

    assert.equal(prompt, 'prompt from file')
    await rm(tempDir, { recursive: true, force: true })
  })

  test('combines message and file content', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'jarvis-prompt-'))
    const filePath = join(tempDir, 'prompt.txt')
    await writeFile(filePath, 'file body', 'utf-8')

    const prompt = await buildPromptInput({
      message: 'instructions',
      filePath,
    })

    assert.equal(
      prompt,
      `instructions\n\n--- File: ${filePath} ---\nfile body`
    )
    await rm(tempDir, { recursive: true, force: true })
  })

  test('throws when prompt is empty', async () => {
    await assert.rejects(
      async () => await buildPromptInput({}),
      /Prompt is required/
    )
  })
})
