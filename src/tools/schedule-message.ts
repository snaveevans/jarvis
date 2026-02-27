import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type pino from 'pino'

import type { Tool, ToolResult, ToolExecutionContext } from './types.ts'

export interface ScheduledMessage {
  id: string
  text: string
  sessionId: string
  endpointKind: string
  createdAt: number
  fireAt: number
}

interface ScheduledMessageStore {
  messages: ScheduledMessage[]
}

export interface ScheduleMessageConfig {
  sendProactive: (params: { sessionId: string, endpointKind: string, text: string, skipLLM?: boolean }) => Promise<void>
  dataDir: string
  logger: pino.Logger
  retryDelayMs?: number
}

export interface ScheduleMessageHandle {
  tools: Tool[]
  initialize(): Promise<void>
  shutdown(): void
}

export function createScheduleMessageTools(config: ScheduleMessageConfig): ScheduleMessageHandle {
  const storePath = path.join(config.dataDir, 'scheduled-messages.json')
  const retryDelayMs = Math.max(1, config.retryDelayMs ?? 60_000)
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let messages: ScheduledMessage[] = []

  async function loadStore(): Promise<void> {
    try {
      const data = await readFile(storePath, 'utf-8')
      const store: ScheduledMessageStore = JSON.parse(data)
      messages = store.messages
    } catch {
      messages = []
    }
  }

  async function saveStore(): Promise<void> {
    const dir = path.dirname(storePath)
    await mkdir(dir, { recursive: true })
    const store: ScheduledMessageStore = { messages }
    const tmpPath = `${storePath}.tmp`
    await writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf-8')
    await rename(tmpPath, storePath)
  }

  function scheduleDelivery(msg: ScheduledMessage): void {
    const now = Date.now()
    const delayMs = Math.max(0, msg.fireAt - now)

    const timer = setTimeout(async () => {
      timers.delete(msg.id)
      try {
        await config.sendProactive({
          sessionId: msg.sessionId,
          endpointKind: msg.endpointKind,
          text: msg.text,
          skipLLM: true,
        })

        messages = messages.filter(m => m.id !== msg.id)
        await saveStore()
      } catch (err) {
        config.logger.error(
          { messageId: msg.id, error: String(err), retryDelayMs },
          'Failed to deliver scheduled message; retrying'
        )
        const idx = messages.findIndex(m => m.id === msg.id)
        if (idx === -1) {
          return
        }
        const retried: ScheduledMessage = {
          ...messages[idx],
          fireAt: Date.now() + retryDelayMs,
        }
        messages[idx] = retried
        try {
          await saveStore()
          scheduleDelivery(retried)
        } catch (retryError) {
          config.logger.error(
            { messageId: msg.id, error: String(retryError) },
            'Failed to persist scheduled message retry'
          )
        }
      }
    }, delayMs)

    timers.set(msg.id, timer)
  }

  const scheduleMessageTool: Tool = {
    name: 'schedule_message',
    description: 'Schedule a text message to be delivered to the current session after a delay',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The message text to deliver',
        },
        delay_minutes: {
          type: 'number',
          description: 'Number of minutes to wait before delivering (minimum 1)',
        },
      },
      required: ['text', 'delay_minutes'],
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
      if (!ctx) {
        return { content: '', error: 'Session context required to schedule a message' }
      }

      const text = args.text as string
      const delayMinutes = args.delay_minutes as number

      if (!text || typeof text !== 'string') {
        return { content: '', error: 'text is required and must be a string' }
      }
      if (typeof delayMinutes !== 'number' || delayMinutes < 1) {
        return { content: '', error: 'delay_minutes must be a number >= 1' }
      }

      const now = Date.now()
      const msg: ScheduledMessage = {
        id: randomUUID(),
        text,
        sessionId: ctx.sessionId,
        endpointKind: ctx.endpointKind,
        createdAt: now,
        fireAt: now + delayMinutes * 60_000,
      }

      messages.push(msg)
      await saveStore()
      scheduleDelivery(msg)

      return {
        content: `Message scheduled (ID: ${msg.id}). Will be delivered in ${delayMinutes} minute(s).`,
      }
    },
  }

  const listScheduledMessagesTool: Tool = {
    name: 'list_scheduled_messages',
    description: 'List pending scheduled messages for the current session with time remaining',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute(_args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
      const filtered = ctx
        ? messages.filter(m => m.sessionId === ctx.sessionId)
        : messages

      if (filtered.length === 0) {
        return { content: 'No scheduled messages.' }
      }

      const now = Date.now()
      const lines = filtered.map(m => {
        const remainingMs = m.fireAt - now
        const remainingMin = Math.max(0, Math.ceil(remainingMs / 60_000))
        return `- [${m.id}] "${m.text}" — delivers in ${remainingMin} minute(s)`
      })

      return { content: lines.join('\n') }
    },
  }

  const cancelScheduledMessageTool: Tool = {
    name: 'cancel_scheduled_message',
    description: 'Cancel a pending scheduled message by ID (scoped by default, global when requested)',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The ID of the scheduled message to cancel',
        },
        global: {
          type: 'boolean',
          description: 'When true, cancel by ID across sessions. Default is false (current session only).',
        },
      },
      required: ['message_id'],
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
      const globalCancel = args.global === true
      if (!globalCancel && !ctx) {
        return { content: '', error: 'Session context required to cancel a message' }
      }

      const messageId = args.message_id as string
      if (!messageId || typeof messageId !== 'string') {
        return { content: '', error: 'message_id is required and must be a string' }
      }

      const sessionId = ctx?.sessionId
      const endpointKind = ctx?.endpointKind
      const idx = globalCancel
        ? messages.findIndex(m => m.id === messageId)
        : messages.findIndex(
          m => m.id === messageId && m.sessionId === sessionId && m.endpointKind === endpointKind
        )
      if (idx === -1) {
        return { content: '', error: `Scheduled message not found: ${messageId}` }
      }

      const timer = timers.get(messageId)
      if (timer) {
        clearTimeout(timer)
        timers.delete(messageId)
      }

      messages.splice(idx, 1)
      await saveStore()

      return { content: `Scheduled message ${messageId} cancelled.` }
    },
  }

  return {
    tools: [scheduleMessageTool, listScheduledMessagesTool, cancelScheduledMessageTool],

    async initialize(): Promise<void> {
      await loadStore()

      for (const msg of messages) {
        scheduleDelivery(msg)
      }

      config.logger.info({ count: messages.length }, 'Schedule message tools initialized')
    },

    shutdown(): void {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
    },
  }
}
