import { chatWithTools } from './llm/index.ts'
import { createLogger } from './logger.ts'
import { getToolDefinitions, executeTool as baseExecuteTool } from './tools/index.ts'

import type { ChatWithToolsClient, ChatMessage } from './llm/index.ts'
import type { Endpoint, EndpointProfile, InboundMessage } from './endpoints/types.ts'
import type { MemoryService } from './memory/index.ts'
import type { SessionStore } from './sessions/store.ts'
import type { LoggerConfig } from './logger.ts'
import type { Tool, ToolCall, ToolResult, ToolExecutionContext } from './tools/types.ts'
import type { ToolDefinition } from './llm/chat-with-tools.ts'
import type { SkillRegistry } from './skills/index.ts'

const DEFAULT_BASE_PROMPT =
  'You are a helpful assistant with access to tools: read, glob, grep, edit, write, shell, ask_user, todo_list, web_fetch, sub_agent, and read_file. Prefer specialized tools over shell for file operations.'
const DEFAULT_SUMMARY_WINDOW_MS = 30 * 60 * 1000

export interface DispatcherConfig {
  client: ChatWithToolsClient
  sessionStore: SessionStore
  model: string
  baseSystemPrompt?: string
  logger?: LoggerConfig
  extraTools?: Tool[]
  skillRegistry?: SkillRegistry
  memoryService?: MemoryService
  summaryWindowMs?: number
  autoSummarize?: boolean
}

export interface Dispatcher {
  registerEndpoint(endpoint: Endpoint): void
  handleInbound(message: InboundMessage): Promise<void>
  sendProactive(params: { sessionId: string, endpointKind: string, text: string }): Promise<void>
  waitForIdle(timeoutMs?: number): Promise<void>
  flushMemoryWrites(timeoutMs?: number): Promise<void>
  start(): Promise<() => void>
}

export function buildSystemPrompt(basePrompt: string, profile: EndpointProfile): string {
  const lines: string[] = []

  lines.push(`You are responding via ${profile.displayName}.`)
  lines.push(profile.responseStyle)

  if (profile.maxMessageLength) {
    lines.push(`Keep individual messages under ${profile.maxMessageLength} characters.`)
  }

  lines.push(`Use ${profile.formatting} formatting.`)
  lines.push('')
  lines.push(basePrompt)

  return lines.join('\n')
}

export function createDispatcher(config: DispatcherConfig): Dispatcher {
  const endpoints = new Map<string, Endpoint>()
  const logger = createLogger(config.logger)
  const basePrompt = config.baseSystemPrompt ?? DEFAULT_BASE_PROMPT
  const { skillRegistry } = config
  const extraTools = config.extraTools ?? []
  const memoryService = config.memoryService
  const pendingMemoryWrites = new Set<Promise<void>>()
  let activeOperations = 0
  const idleResolvers = new Set<() => void>()
  const summaryWindowMs = config.summaryWindowMs ?? DEFAULT_SUMMARY_WINDOW_MS
  const autoSummarize = config.autoSummarize ?? true
  const sessionSummaryWindows = new Map<string, Array<{
    timestampMs: number
    hadToolCalls: boolean
    messages: ChatMessage[]
  }>>()
  const sessionLastSummarizedAt = new Map<string, number>()

  // Build merged tool definitions and executor if we have extra tools
  let mergedToolOptions: { tools?: ToolDefinition[], executeTool?: (call: ToolCall, ctx?: ToolExecutionContext) => Promise<ToolResult> } = {}

  if (extraTools.length > 0) {
    const extraToolMap = new Map<string, Tool>()
    for (const tool of extraTools) {
      extraToolMap.set(tool.name, tool)
    }

    const extraDefs: ToolDefinition[] = extraTools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    mergedToolOptions = {
      tools: [...getToolDefinitions(), ...extraDefs],
      executeTool: async (call: ToolCall, ctx?: ToolExecutionContext): Promise<ToolResult> => {
        const extraTool = extraToolMap.get(call.function.name)
        if (extraTool) {
          try {
            const args = JSON.parse(call.function.arguments)
            return await extraTool.execute(args, ctx)
          } catch (error) {
            return {
              content: '',
              error: `Failed to execute tool ${call.function.name}: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        }
        return baseExecuteTool(call, ctx)
      },
    }
  }

  function buildFullSystemPrompt(profile: EndpointProfile): string {
    let prompt = buildSystemPrompt(basePrompt, profile)
    if (skillRegistry) {
      const skillBlock = skillRegistry.getSystemPromptBlock()
      if (skillBlock) {
        prompt += '\n\n' + skillBlock
      }
    }
    return prompt
  }

  function getMemoryContext(query: string): string | undefined {
    if (!memoryService) {
      return undefined
    }

    try {
      return memoryService.getAutoContext(query)
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Memory auto-retrieval failed'
      )
      return undefined
    }
  }

  function summarizeSession(
    sessionId: string,
    messages: ChatMessage[],
    hadToolCalls: boolean,
    timestampMs: number
  ): void {
    if (!memoryService || !autoSummarize) {
      return
    }

    const existing = sessionSummaryWindows.get(sessionId) ?? []
    existing.push({ timestampMs, hadToolCalls, messages })
    const cutoffMs = timestampMs - summaryWindowMs
    const windowEntries = existing.filter(entry => entry.timestampMs >= cutoffMs)
    sessionSummaryWindows.set(sessionId, windowEntries)

    const lastSummarizedAt = sessionLastSummarizedAt.get(sessionId) ?? 0
    const unsummarizedEntries = windowEntries.filter(entry => entry.timestampMs > lastSummarizedAt)

    if (unsummarizedEntries.length === 0) {
      logger.info(
        { sessionId, windowMinutes: Math.round(summaryWindowMs / 60000), reason: 'no_new_messages' },
        'Auto-memory summarize skipped'
      )
      return
    }

    const candidateMessages = unsummarizedEntries.flatMap(entry => entry.messages)
    const candidateHadToolCalls = unsummarizedEntries.some(entry => entry.hadToolCalls)
    const rangeStartMs = unsummarizedEntries[0].timestampMs
    const rangeEndMs = unsummarizedEntries[unsummarizedEntries.length - 1].timestampMs
    const source = `${sessionId} window ${new Date(rangeStartMs).toISOString()}..${new Date(rangeEndMs).toISOString()}`

    logger.info(
      {
        sessionId,
        source,
        hadToolCalls: candidateHadToolCalls,
        messageCount: candidateMessages.length,
        windowMinutes: Math.round(summaryWindowMs / 60000),
      },
      'Auto-memory summarize queued'
    )

    const write = (async () => {
      const outcome = await memoryService.summarizeAndStore({
        client: config.client,
        model: config.model,
        messages: candidateMessages,
        hadToolCalls: candidateHadToolCalls,
        source,
        force: true,
      })

      logger.info(
        { sessionId, source, outcome, coveredMessages: candidateMessages.length },
        'Auto-memory summarize window outcome'
      )

      if (outcome === 'stored' || outcome === 'deduplicated') {
        sessionLastSummarizedAt.set(sessionId, rangeEndMs)
      }
    })()

    pendingMemoryWrites.add(write)
    void write.finally(() => {
      pendingMemoryWrites.delete(write)
    })
  }

  function beginOperation(): void {
    activeOperations++
  }

  function endOperation(): void {
    activeOperations = Math.max(0, activeOperations - 1)
    if (activeOperations === 0) {
      for (const resolve of idleResolvers) {
        resolve()
      }
      idleResolvers.clear()
    }
  }

  const dispatcher: Dispatcher = {
    registerEndpoint(endpoint: Endpoint): void {
      endpoints.set(endpoint.profile.kind, endpoint)
    },

    async handleInbound(message: InboundMessage): Promise<void> {
      beginOperation()
      try {
        const endpoint = endpoints.get(message.endpointKind)
        if (!endpoint) {
          logger.error({ endpointKind: message.endpointKind }, 'No endpoint registered for kind')
          return
        }

        // Handle /clear command
        if (message.text === '/clear') {
          config.sessionStore.clear(message.sessionId)
          await endpoint.send({
            text: 'Conversation cleared.',
            sessionId: message.sessionId,
            endpointKind: message.endpointKind,
          })
          return
        }

        const session = config.sessionStore.getOrCreate(message.sessionId, message.endpointKind)

        // Inject system prompt if this is a fresh session
        if (session.messages.length === 0) {
          const systemPrompt = buildFullSystemPrompt(endpoint.profile)
          config.sessionStore.addMessage(session.id, { role: 'system', content: systemPrompt })
        }

        // Add user message
        const interactionStart = session.messages.length
        config.sessionStore.addMessage(session.id, { role: 'user', content: message.text })

        const toolContext = { sessionId: message.sessionId, endpointKind: message.endpointKind }
        const memoryContext = getMemoryContext(message.text)
        const llmMessages = memoryContext
          ? [{ role: 'system', content: memoryContext } as ChatMessage, ...session.messages]
          : session.messages
        let hadToolCalls = false

        try {
          const response = await chatWithTools(config.client, llmMessages, {
            model: config.model,
            ...mergedToolOptions,
            toolContext,
            onToolCall: (observation) => {
              hadToolCalls = true
              logger.info(
                {
                  sessionId: message.sessionId,
                  event: 'tool_call',
                  iteration: observation.iteration,
                  toolName: observation.toolCall.function.name,
                  success: !observation.result.error,
                },
                'Tool call executed'
              )
            },
          })

          const content = response.choices[0]?.message?.content
          if (!content) {
            await endpoint.send({
              text: '(No response from LLM)',
              sessionId: message.sessionId,
              endpointKind: message.endpointKind,
            })
            return
          }

          // Store assistant response
          config.sessionStore.addMessage(session.id, { role: 'assistant', content })

          await endpoint.send({
            text: content,
            sessionId: message.sessionId,
            endpointKind: message.endpointKind,
          })

          const interactionMessages = session.messages.slice(interactionStart)
          summarizeSession(
            session.id,
            interactionMessages,
            hadToolCalls,
            message.timestamp.getTime()
          )
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          logger.error({ sessionId: message.sessionId, error: errorMessage }, 'Error processing message')

          // Remove failed user message to keep history clean
          session.messages.pop()

          await endpoint.send({
            text: `Sorry, something went wrong: ${errorMessage}`,
            sessionId: message.sessionId,
            endpointKind: message.endpointKind,
          })
        }
      } finally {
        endOperation()
      }
    },

    async sendProactive(params: { sessionId: string, endpointKind: string, text: string }): Promise<void> {
      beginOperation()
      try {
        const endpoint = endpoints.get(params.endpointKind)
        if (!endpoint) {
          logger.error({ endpointKind: params.endpointKind }, 'No endpoint registered for proactive send')
          return
        }

        const session = config.sessionStore.getOrCreate(params.sessionId, params.endpointKind)

        // Inject system prompt if fresh session
        if (session.messages.length === 0) {
          const systemPrompt = buildFullSystemPrompt(endpoint.profile)
          config.sessionStore.addMessage(session.id, { role: 'system', content: systemPrompt })
        }

        // Add the proactive message as a user message
        const interactionStart = session.messages.length
        config.sessionStore.addMessage(session.id, { role: 'user', content: params.text })

        const toolContext = { sessionId: params.sessionId, endpointKind: params.endpointKind }
        const memoryContext = getMemoryContext(params.text)
        const llmMessages = memoryContext
          ? [{ role: 'system', content: memoryContext } as ChatMessage, ...session.messages]
          : session.messages
        let hadToolCalls = false

        try {
          const response = await chatWithTools(config.client, llmMessages, {
            model: config.model,
            ...mergedToolOptions,
            toolContext,
            onToolCall: () => {
              hadToolCalls = true
            },
          })

          const content = response.choices[0]?.message?.content
          if (!content) return

          config.sessionStore.addMessage(session.id, { role: 'assistant', content })

          await endpoint.send({
            text: content,
            sessionId: params.sessionId,
            endpointKind: params.endpointKind,
          })

          const interactionMessages = session.messages.slice(interactionStart)
          summarizeSession(
            session.id,
            interactionMessages,
            hadToolCalls,
            Date.now()
          )
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          logger.error({ sessionId: params.sessionId, error: errorMessage }, 'Error in proactive send')
          session.messages.pop()
        }
      } finally {
        endOperation()
      }
    },

    async waitForIdle(timeoutMs: number = 3000): Promise<void> {
      if (activeOperations === 0) {
        return
      }

      let timedOut = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined

      await Promise.race([
        new Promise<void>((resolve) => {
          idleResolvers.add(resolve)
        }),
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            resolve()
          }, timeoutMs)
        }),
      ])

      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }

      if (timedOut && activeOperations > 0) {
        logger.warn(
          { activeOperations, timeoutMs },
          'Timed out waiting for active operations to finish'
        )
      }
    },

    async flushMemoryWrites(timeoutMs: number = 3000): Promise<void> {
      if (!memoryService || pendingMemoryWrites.size === 0) {
        return
      }

      const writes = [...pendingMemoryWrites]
      let timedOut = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined

      await Promise.race([
        Promise.allSettled(writes),
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            resolve()
          }, timeoutMs)
        }),
      ])

      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }

      if (timedOut && pendingMemoryWrites.size > 0) {
        logger.warn(
          { pending: pendingMemoryWrites.size, timeoutMs },
          'Timed out waiting for pending memory writes'
        )
      }
    },

    async start(): Promise<() => void> {
      const cleanups: Array<() => void> = []

      for (const endpoint of endpoints.values()) {
        if (endpoint.listen) {
          const stop = await endpoint.listen((message) => dispatcher.handleInbound(message))
          cleanups.push(stop)
        }
      }

      return () => {
        for (const cleanup of cleanups) {
          cleanup()
        }
      }
    },
  }

  return dispatcher
}
