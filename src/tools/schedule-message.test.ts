import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pino from 'pino'

import { createScheduleMessageTools } from './schedule-message.ts'

import type { ToolExecutionContext } from './types.ts'
import type { ScheduleMessageConfig } from './schedule-message.ts'

function createTestConfig(dataDir: string, sendProactive?: ScheduleMessageConfig['sendProactive']): ScheduleMessageConfig {
  return {
    sendProactive: sendProactive ?? (async () => {}),
    dataDir,
    logger: pino({ level: 'silent' }),
  }
}

const ctx: ToolExecutionContext = {
  sessionId: 'test-session',
  endpointKind: 'test',
}

describe('schedule-message tools', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'jarvis-schedule-msg-test-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  test('creates three tools with correct names', () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    assert.equal(handle.tools.length, 3)
    assert.deepEqual(
      handle.tools.map(t => t.name),
      ['schedule_message', 'list_scheduled_messages', 'cancel_scheduled_message']
    )
  })

  test('schedule_message persists and returns ID', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const tool = handle.tools.find(t => t.name === 'schedule_message')!
    const result = await tool.execute({ text: 'hello later', delay_minutes: 5 }, ctx)

    assert.ok(!result.error)
    assert.ok(result.content.includes('Message scheduled'))
    assert.ok(result.content.includes('5 minute(s)'))

    // Persisted
    const data = JSON.parse(await readFile(path.join(dataDir, 'scheduled-messages.json'), 'utf-8'))
    assert.equal(data.messages.length, 1)
    assert.equal(data.messages[0].text, 'hello later')
    assert.equal(data.messages[0].sessionId, 'test-session')

    handle.shutdown()
  })

  test('schedule_message rejects missing context', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const tool = handle.tools.find(t => t.name === 'schedule_message')!
    const result = await tool.execute({ text: 'test', delay_minutes: 5 })
    assert.ok(result.error)
    assert.ok(result.error.includes('Session context required'))

    handle.shutdown()
  })

  test('schedule_message rejects delay < 1', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const tool = handle.tools.find(t => t.name === 'schedule_message')!
    const result = await tool.execute({ text: 'test', delay_minutes: 0 }, ctx)
    assert.ok(result.error)
    assert.ok(result.error.includes('>= 1'))

    handle.shutdown()
  })

  test('list_scheduled_messages shows pending messages', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const schedule = handle.tools.find(t => t.name === 'schedule_message')!
    const list = handle.tools.find(t => t.name === 'list_scheduled_messages')!

    const empty = await list.execute({}, ctx)
    assert.equal(empty.content, 'No scheduled messages.')

    await schedule.execute({ text: 'test msg', delay_minutes: 10 }, ctx)
    const result = await list.execute({}, ctx)
    assert.ok(result.content.includes('test msg'))
    assert.ok(result.content.includes('minute(s)'))

    handle.shutdown()
  })

  test('list_scheduled_messages filters by session', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const schedule = handle.tools.find(t => t.name === 'schedule_message')!
    const list = handle.tools.find(t => t.name === 'list_scheduled_messages')!

    await schedule.execute({ text: 'msg for s1', delay_minutes: 10 }, { sessionId: 's1', endpointKind: 'test' })
    await schedule.execute({ text: 'msg for s2', delay_minutes: 10 }, { sessionId: 's2', endpointKind: 'test' })

    const result = await list.execute({}, { sessionId: 's1', endpointKind: 'test' })
    assert.ok(result.content.includes('msg for s1'))
    assert.ok(!result.content.includes('msg for s2'))

    handle.shutdown()
  })

  test('cancel_scheduled_message removes a message', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const schedule = handle.tools.find(t => t.name === 'schedule_message')!
    const cancel = handle.tools.find(t => t.name === 'cancel_scheduled_message')!
    const list = handle.tools.find(t => t.name === 'list_scheduled_messages')!

    const setResult = await schedule.execute({ text: 'to cancel', delay_minutes: 10 }, ctx)
    const idMatch = setResult.content.match(/ID: ([a-f0-9-]+)/)
    assert.ok(idMatch)

    const cancelResult = await cancel.execute({ message_id: idMatch![1] }, ctx)
    assert.ok(!cancelResult.error)
    assert.ok(cancelResult.content.includes('cancelled'))

    const listResult = await list.execute({}, ctx)
    assert.equal(listResult.content, 'No scheduled messages.')

    handle.shutdown()
  })

  test('cancel_scheduled_message errors on unknown ID', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const cancel = handle.tools.find(t => t.name === 'cancel_scheduled_message')!
    const result = await cancel.execute({ message_id: 'nonexistent' }, ctx)
    assert.ok(result.error)
    assert.ok(result.error.includes('not found'))

    handle.shutdown()
  })

  test('cancel_scheduled_message cannot cancel another session message', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const schedule = handle.tools.find(t => t.name === 'schedule_message')!
    const cancel = handle.tools.find(t => t.name === 'cancel_scheduled_message')!
    const list = handle.tools.find(t => t.name === 'list_scheduled_messages')!

    const setResult = await schedule.execute({ text: 'session scoped', delay_minutes: 10 }, ctx)
    const idMatch = setResult.content.match(/ID: ([a-f0-9-]+)/)
    assert.ok(idMatch)

    const cancelResult = await cancel.execute(
      { message_id: idMatch![1] },
      { sessionId: 'other-session', endpointKind: 'test' }
    )
    assert.ok(cancelResult.error)
    assert.ok(cancelResult.error.includes('not found'))

    const listResult = await list.execute({}, ctx)
    assert.ok(listResult.content.includes('session scoped'))

    handle.shutdown()
  })

  test('cancel_scheduled_message can cancel another session message when global=true', async () => {
    const handle = createScheduleMessageTools(createTestConfig(dataDir))
    await handle.initialize()

    const schedule = handle.tools.find(t => t.name === 'schedule_message')!
    const cancel = handle.tools.find(t => t.name === 'cancel_scheduled_message')!
    const list = handle.tools.find(t => t.name === 'list_scheduled_messages')!

    const setResult = await schedule.execute({ text: 'cross session cancel', delay_minutes: 10 }, ctx)
    const idMatch = setResult.content.match(/ID: ([a-f0-9-]+)/)
    assert.ok(idMatch)

    const cancelResult = await cancel.execute(
      { message_id: idMatch![1], global: true },
      { sessionId: 'other-session', endpointKind: 'test' }
    )
    assert.ok(!cancelResult.error)
    assert.ok(cancelResult.content.includes('cancelled'))

    const listResult = await list.execute({}, ctx)
    assert.equal(listResult.content, 'No scheduled messages.')

    handle.shutdown()
  })

  test('expired messages fire on initialize', async () => {
    const sent: Array<{ sessionId: string, text: string }> = []
    const sendProactive = async (params: { sessionId: string, endpointKind: string, text: string }) => {
      sent.push({ sessionId: params.sessionId, text: params.text })
    }

    // Create a message and shut down
    const h1 = createScheduleMessageTools(createTestConfig(dataDir, sendProactive))
    await h1.initialize()
    const schedule = h1.tools.find(t => t.name === 'schedule_message')!
    await schedule.execute({ text: 'overdue msg', delay_minutes: 1 }, ctx)
    h1.shutdown()

    // Manually expire it
    const data = JSON.parse(await readFile(path.join(dataDir, 'scheduled-messages.json'), 'utf-8'))
    data.messages[0].fireAt = Date.now() - 1000
    await writeFile(path.join(dataDir, 'scheduled-messages.json'), JSON.stringify(data), 'utf-8')

    // Re-initialize — should fire immediately
    const h2 = createScheduleMessageTools(createTestConfig(dataDir, sendProactive))
    await h2.initialize()
    await new Promise(resolve => setTimeout(resolve, 50))

    assert.ok(sent.length > 0)
    assert.ok(sent[0].text.includes('overdue msg'))
    assert.equal(sent[0].sessionId, 'test-session')

    h2.shutdown()
  })

  test('pending messages survive restart', async () => {
    const h1 = createScheduleMessageTools(createTestConfig(dataDir))
    await h1.initialize()
    const schedule = h1.tools.find(t => t.name === 'schedule_message')!
    await schedule.execute({ text: 'future msg', delay_minutes: 60 }, ctx)
    h1.shutdown()

    const h2 = createScheduleMessageTools(createTestConfig(dataDir))
    await h2.initialize()
    const list = h2.tools.find(t => t.name === 'list_scheduled_messages')!
    const result = await list.execute({}, ctx)
    assert.ok(result.content.includes('future msg'))

    h2.shutdown()
  })

  test('failed delivery is retried and not dropped', async () => {
    let attempts = 0
    const sent: Array<{ sessionId: string, text: string }> = []
    const sendProactive = async (params: { sessionId: string, endpointKind: string, text: string }) => {
      attempts++
      if (attempts === 1) {
        throw new Error('temporary send failure')
      }
      sent.push({ sessionId: params.sessionId, text: params.text })
    }

    const h1 = createScheduleMessageTools({
      ...createTestConfig(dataDir, sendProactive),
      retryDelayMs: 20,
    })
    await h1.initialize()
    const schedule = h1.tools.find(t => t.name === 'schedule_message')!
    await schedule.execute({ text: 'retry me', delay_minutes: 1 }, ctx)
    h1.shutdown()

    const storePath = path.join(dataDir, 'scheduled-messages.json')
    const data = JSON.parse(await readFile(storePath, 'utf-8'))
    data.messages[0].fireAt = Date.now() - 1000
    await writeFile(storePath, JSON.stringify(data), 'utf-8')

    const h2 = createScheduleMessageTools({
      ...createTestConfig(dataDir, sendProactive),
      retryDelayMs: 20,
    })
    await h2.initialize()
    await new Promise(resolve => setTimeout(resolve, 80))

    assert.ok(attempts >= 2)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, 'retry me')

    const finalStore = JSON.parse(await readFile(storePath, 'utf-8'))
    assert.equal(finalStore.messages.length, 0)

    h2.shutdown()
  })
})
