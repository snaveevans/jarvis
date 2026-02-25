import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert'

import { createLogger } from '../logger.ts'

describe('createLogger', () => {
  test('creates a logger with stdout defaults', () => {
    const logger = createLogger()
    assert.ok(logger)
  })

  test('writes logs to a file when filePath is provided', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'jarvis-logger-'))
    const logFilePath = join(tempDir, 'tool-calls.log')
    const logger = createLogger({
      filePath: logFilePath,
      toStdout: false,
      level: 'info',
    })

    logger.info({ event: 'tool_call', toolName: 'read_file' }, 'Tool call executed')
    logger.flush()

    const logContents = await readFile(logFilePath, 'utf-8')
    assert.match(logContents, /"event":"tool_call"/)
    assert.match(logContents, /Tool call executed/)

    await rm(tempDir, { recursive: true, force: true })
  })
})
