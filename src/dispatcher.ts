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
import type { EventStore } from './telemetry/event-store.ts'

const DEFAULT_BASE_PROMPT = [
  'You are an autonomous agent that takes action to accomplish tasks.',
  'When the user asks you to do something, DO IT — use your tools to execute commands, read files, write code, and complete the task.',
  'Never tell the user to run a command themselves if you can run it with the shell tool.',
  'Never say "you can do X" — just do X.',
  'Prefer specialized tools (read, edit, write, glob, grep) over shell for file operations.',
  'Use shell for: building, testing, installing dependencies, git operations, running scripts, and any system command.',
  'Use ask_user only when genuinely ambiguous — not as a way to avoid taking action.',
  'Conversation history may be restored after restarts; treat prior messages in context as authoritative.',
].join(' ')

export interface DispatcherConfig {
  client: ChatWithToolsClient
  sessionStore: SessionStore
  model: string
  providerName?: string
  baseSystemPrompt?: string
  logger?: LoggerConfig
  extraTools?: Tool[]
  skillRegistry?: SkillRegistry
  memoryService?: MemoryService
  /** @deprecated No longer used — eviction-based memory replaces time-window summarization */
  summaryWindowMs?: number
  /** @deprecated No longer used — eviction-based memory replaces time-window summarization */
  autoSummarize?: boolean
  maxToolIterations?: number
  maxParallelTools?: number
  eventStore?: EventStore
  searchPool?: ToolExecutionContext['searchPool']
  shellPool?: ToolExecutionContext['shellPool']
}

export interface Dispatcher {
  registerEndpoint(endpoint: Endpoint): void
  handleInbound(message: InboundMessage): Promise<void>
  sendProactive(params: { sessionId: string, endpointKind: string, text: string, skipLLM?: boolean }): Promise<void>
  waitForIdle(timeoutMs?: number): Promise<void>
  flushMemoryWrites(timeoutMs?: number): Promise<void>
  start(): Promise<() => void>
}

function formatCurrentTimeContext(now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local'
  const localTime = now.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  })

  return `Current local time: ${localTime}. Timezone: ${zone}.`
}

export function buildSystemPrompt(
  basePrompt: string,
  profile: EndpointProfile,
  runtime?: { providerName?: string, model?: string, now?: Date }
): string {
  const lines: string[] = []

  lines.push(`You are responding via ${profile.displayName}.`)
  lines.push(profile.responseStyle)

  if (profile.maxMessageLength) {
    lines.push(`Keep individual messages under ${profile.maxMessageLength} characters.`)
  }

  lines.push(`Use ${profile.formatting} formatting.`)
  lines.push(formatCurrentTimeContext(runtime?.now ?? new Date()))
  if (runtime?.providerName || runtime?.model) {
    const providerName = runtime.providerName ?? 'unknown'
    const model = runtime.model ?? 'unknown'
    lines.push(`Current LLM provider: ${providerName}.`)
    lines.push(`Current model: ${model}.`)
  }
  lines.push('')
  lines.push(basePrompt)

  return lines.join('\n')
}

export function createDispatcher(config: DispatcherConfig): Dispatcher {
  const endpoints = new Map<string, Endpoint>()
  const logger = createLogger(config.logger)
  const basePrompt = config.baseSystemPrompt ?? DEFAULT_BASE_PROMPT
  const { skillRegistry, eventStore } = config
  const extraTools = config.extraTools ?? []
  const memoryService = config.memoryService
  const pendingMemoryWrites = new Set<Promise<void>>()
  let activeOperations = 0
  const idleResolvers = new Set<() => void>()

  // Track active sessions for cancellation support
  const activeSessions = new Map<string, { abortController: AbortController, isProcessing: boolean }>()

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
    let prompt = buildSystemPrompt(basePrompt, profile, {
      providerName: config.providerName,
      model: config.model,
    })
    if (skillRegistry) {
      const skillBlock = skillRegistry.getSystemPromptBlock()
      if (skillBlock) {
        prompt += '\n\n' + skillBlock
      }
    }
    if (memoryService) {
      prompt += '\n\n' + [
        'You have persistent memory across conversations. Relevant memories are automatically provided below.',
        'Proactively use memory_store to remember user preferences, decisions, and project context — do this silently without announcing it.',
        'Use memory_search when the user\'s question might benefit from prior context you\'ve stored.',
      ].join('\n')
    }
    return prompt
  }

  function toUserVisibleContent(content: string): string {
    if (typeof config.client.toUserVisibleContent === 'function') {
      return config.client.toUserVisibleContent(content)
    }
    return content
  }

  async function getMemoryContext(query: string): Promise<string | undefined> {
    if (!memoryService) {
      return undefined
    }

    try {
      return await memoryService.getAutoContext(query)
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Memory auto-retrieval failed'
      )
      return undefined
    }
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
          eventStore?.record({
            type: 'session',
            sessionId: message.sessionId,
            action: 'cleared',
          })
          await endpoint.send({
            text: 'Conversation cleared.',
            sessionId: message.sessionId,
            endpointKind: message.endpointKind,
          })
          return
        }

        // Handle stop/wait command - cancel ongoing processing
        const command = message.text.trim().toLowerCase()
        if (command === 'stop' || command === 'wait') {
          const activeSession = activeSessions.get(message.sessionId)
          if (activeSession?.isProcessing) {
            activeSession.abortController.abort()
            await endpoint.send({
              text: 'Stopping...',
              sessionId: message.sessionId,
              endpointKind: message.endpointKind,
            })
          } else {
            await endpoint.send({
              text: 'Nothing to stop.',
              sessionId: message.sessionId,
              endpointKind: message.endpointKind,
            })
          }
          return
        }

        const session = config.sessionStore.getOrCreate(message.sessionId, message.endpointKind)

        // Keep system prompt in sync so newly added skills become available without restart.
        const systemPrompt = buildFullSystemPrompt(endpoint.profile)
        if (session.messages.length === 0) {
          config.sessionStore.addMessage(session.id, { role: 'system', content: systemPrompt })
        } else if (session.messages[0]?.role !== 'system') {
          session.messages.unshift({ role: 'system', content: systemPrompt })
        } else if (session.messages[0]?.role === 'system' && session.messages[0].content !== systemPrompt) {
          session.messages[0] = { role: 'system', content: systemPrompt }
        }

        // Add user message
        config.sessionStore.addMessage(session.id, { role: 'user', content: message.text })

        // Create abort controller for this session
        const abortController = new AbortController()
        activeSessions.set(message.sessionId, { abortController, isProcessing: true })

        const toolContext: ToolExecutionContext = {
          sessionId: message.sessionId,
          endpointKind: message.endpointKind,
          searchPool: config.searchPool,
          shellPool: config.shellPool,
          signal: abortController.signal,
        }
        // Merge memory context into the system prompt rather than prepending a
        // separate system message. Some LLM APIs (e.g. MiniMax) reject multiple
        // system messages or system messages after position 0.
        const memoryContext = await getMemoryContext(message.text)
        let llmMessages = session.messages
        if (memoryContext && llmMessages.length > 0 && llmMessages[0].role === 'system') {
          llmMessages = [
            { role: 'system', content: `${llmMessages[0].content}\n\n${memoryContext}` },
            ...llmMessages.slice(1),
          ]
        } else if (memoryContext) {
          llmMessages = [{ role: 'system', content: memoryContext } as ChatMessage, ...llmMessages]
        }

        try {
          const llmCallStart = Date.now()
          
          // Track message count to detect new clarifications
          const initialMessageCount = session.messages.length
          
          const response = await chatWithTools(config.client, llmMessages, {
            signal: abortController.signal,
            model: config.model,
            ...mergedToolOptions,
            toolContext,
            maxParallelTools: config.maxParallelTools,
            maxIterations: config.maxToolIterations,
            onToolCall: (observation) => {
              const args = JSON.stringify(JSON.parse(observation.toolCall.function.arguments ?? '{}'))
              logger.info(
                {
                  sessionId: message.sessionId,
                  event: 'tool_call',
                  iteration: observation.iteration,
                  toolName: observation.toolCall.function.name,
                  success: !observation.result.error,
                  durationMs: observation.durationMs,
                },
                'Tool call executed'
              )
              eventStore?.record({
                type: 'tool_call',
                sessionId: message.sessionId,
                toolName: observation.toolCall.function.name,
                argsSummary: args.length > 200 ? args.slice(0, 200) + '…' : args,
                success: !observation.result.error,
                errorMessage: observation.result.error,
                durationMs: observation.durationMs,
                iteration: observation.iteration,
              })
            },
            onCheckNewMessages: async () => {
              // Check for new user messages added to session (clarifications)
              const currentCount = session.messages.length
              if (currentCount > initialMessageCount) {
                // Return new messages (only user messages, not system/assistant/tool)
                const newMessages = session.messages.slice(initialMessageCount)
                const userMessages = newMessages.filter(m => m.role === 'user')
                if (userMessages.length > 0) {
                  logger.info(
                    { sessionId: message.sessionId, count: userMessages.length },
                    'Received clarification messages'
                  )
                  return userMessages
                }
              }
              return undefined
            },
          })

          if (response.usage) {
            const llmDurationMs = Date.now() - llmCallStart
            logger.info(
              {
                sessionId: message.sessionId,
                event: 'llm_usage',
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
              },
              'LLM usage'
            )
            eventStore?.record({
              type: 'llm_call',
              sessionId: message.sessionId,
              model: response.model ?? config.model,
              promptTokens: response.usage.prompt_tokens ?? 0,
              completionTokens: response.usage.completion_tokens ?? 0,
              totalTokens: response.usage.total_tokens ?? 0,
              durationMs: llmDurationMs,
              iteration: 0,
            })
          }

          const content = response.choices[0]?.message?.content
          if (!content) {
            await endpoint.send({
              text: '(No response from LLM)',
              sessionId: message.sessionId,
              endpointKind: message.endpointKind,
            })
            return
          }
          const userVisibleContent = toUserVisibleContent(content)

          // Store only user-visible content so replayed history never includes hidden reasoning.
          config.sessionStore.addMessage(session.id, { role: 'assistant', content: userVisibleContent })

          await endpoint.send({
            text: userVisibleContent,
            sessionId: message.sessionId,
            endpointKind: message.endpointKind,
          })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          const errorCode = (error as { code?: string }).code
          const statusCode = (error as { statusCode?: number }).statusCode
          
          // Handle cancellation specially
          if (errorMessage === 'Stopped by user' || errorMessage === 'Operation cancelled') {
            await endpoint.send({
              text: 'Stopped.',
              sessionId: message.sessionId,
              endpointKind: message.endpointKind,
            })
          } else {
            logger.error({ sessionId: message.sessionId, error: errorMessage }, 'Error processing message')
            eventStore?.record({
              type: 'error',
              sessionId: message.sessionId,
              category: 'dispatch',
              message: errorMessage,
              code: errorCode,
              statusCode,
            })

            // Remove failed user message to keep history clean
            session.messages.pop()

            await endpoint.send({
              text: `Sorry, something went wrong: ${errorMessage}`,
              sessionId: message.sessionId,
              endpointKind: message.endpointKind,
            })
          }
        }
      } finally {
        // Clean up active session tracking
        activeSessions.delete(message.sessionId)
        endOperation()
      }
    },

    async sendProactive(params: { sessionId: string, endpointKind: string, text: string, skipLLM?: boolean }): Promise<void> {
      beginOperation()
      try {
        const endpoint = endpoints.get(params.endpointKind)
        if (!endpoint) {
          logger.error({ endpointKind: params.endpointKind }, 'No endpoint registered for proactive send')
          return
        }

        const session = config.sessionStore.getOrCreate(params.sessionId, params.endpointKind)

        // Keep system prompt in sync so newly added skills become available without restart.
        const systemPrompt = buildFullSystemPrompt(endpoint.profile)
        if (session.messages.length === 0) {
          config.sessionStore.addMessage(session.id, { role: 'system', content: systemPrompt })
        } else if (session.messages[0]?.role !== 'system') {
          session.messages.unshift({ role: 'system', content: systemPrompt })
        } else if (session.messages[0]?.role === 'system' && session.messages[0].content !== systemPrompt) {
          session.messages[0] = { role: 'system', content: systemPrompt }
        }

        if (params.skipLLM === true) {
          config.sessionStore.addMessage(session.id, { role: 'assistant', content: params.text })
          await endpoint.send({
            text: params.text,
            sessionId: params.sessionId,
            endpointKind: params.endpointKind,
          })
          return
        }

        // Add the proactive message as a user message
        config.sessionStore.addMessage(session.id, { role: 'user', content: params.text })

        const toolContext: ToolExecutionContext = {
          sessionId: params.sessionId,
          endpointKind: params.endpointKind,
          searchPool: config.searchPool,
          shellPool: config.shellPool,
        }
        const memoryContext = await getMemoryContext(params.text)
        let llmMessages = session.messages
        if (memoryContext && llmMessages.length > 0 && llmMessages[0].role === 'system') {
          llmMessages = [
            { role: 'system', content: `${llmMessages[0].content}\n\n${memoryContext}` },
            ...llmMessages.slice(1),
          ]
        } else if (memoryContext) {
          llmMessages = [{ role: 'system', content: memoryContext } as ChatMessage, ...llmMessages]
        }

        try {
          const llmStart = Date.now()
          const response = await chatWithTools(config.client, llmMessages, {
            model: config.model,
            ...mergedToolOptions,
            toolContext,
            maxParallelTools: config.maxParallelTools,
            maxIterations: config.maxToolIterations,
            onToolCall: (obs) => {
              eventStore?.record({
                type: 'tool_call',
                sessionId: params.sessionId,
                toolName: obs.toolCall.function.name,
                argsSummary: obs.toolCall.function.arguments.slice(0, 200),
                success: !obs.result.error,
                errorMessage: obs.result.error,
                durationMs: obs.durationMs,
                iteration: obs.iteration,
              })
            },
          })

          const content = response.choices[0]?.message?.content
          if (!content) return
          const userVisibleContent = toUserVisibleContent(content)

          eventStore?.record({
            type: 'llm_call',
            sessionId: params.sessionId,
            model: config.model,
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
            totalTokens: response.usage?.total_tokens ?? 0,
            durationMs: Date.now() - llmStart,
            iteration: 0,
          })

          config.sessionStore.addMessage(session.id, { role: 'assistant', content: userVisibleContent })

          await endpoint.send({
            text: userVisibleContent,
            sessionId: params.sessionId,
            endpointKind: params.endpointKind,
          })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          const errorCode = (error as { code?: string }).code
          const statusCode = (error as { statusCode?: number }).statusCode
          logger.error({ sessionId: params.sessionId, error: errorMessage }, 'Error in proactive send')
          eventStore?.record({
            type: 'error',
            sessionId: params.sessionId,
            category: 'dispatch',
            message: errorMessage,
            code: errorCode,
            statusCode,
          })
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
