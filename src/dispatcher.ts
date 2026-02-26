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
  searchPool?: ToolExecutionContext['searchPool']
  shellPool?: ToolExecutionContext['shellPool']
}

export interface Dispatcher {
  registerEndpoint(endpoint: Endpoint): void
  handleInbound(message: InboundMessage): Promise<void>
  sendProactive(params: { sessionId: string, endpointKind: string, text: string }): Promise<void>
  waitForIdle(timeoutMs?: number): Promise<void>
  flushMemoryWrites(timeoutMs?: number): Promise<void>
  start(): Promise<() => void>
}

export function buildSystemPrompt(
  basePrompt: string,
  profile: EndpointProfile,
  runtime?: { providerName?: string, model?: string }
): string {
  const lines: string[] = []

  lines.push(`You are responding via ${profile.displayName}.`)
  lines.push(profile.responseStyle)

  if (profile.maxMessageLength) {
    lines.push(`Keep individual messages under ${profile.maxMessageLength} characters.`)
  }

  lines.push(`Use ${profile.formatting} formatting.`)
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
  const { skillRegistry } = config
  const extraTools = config.extraTools ?? []
  const memoryService = config.memoryService
  const pendingMemoryWrites = new Set<Promise<void>>()
  let activeOperations = 0
  const idleResolvers = new Set<() => void>()

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
        config.sessionStore.addMessage(session.id, { role: 'user', content: message.text })

        const toolContext: ToolExecutionContext = {
          sessionId: message.sessionId,
          endpointKind: message.endpointKind,
          searchPool: config.searchPool,
          shellPool: config.shellPool,
        }
        const memoryContext = await getMemoryContext(message.text)
        const llmMessages = memoryContext
          ? [{ role: 'system', content: memoryContext } as ChatMessage, ...session.messages]
          : session.messages

        try {
          const response = await chatWithTools(config.client, llmMessages, {
            model: config.model,
            ...mergedToolOptions,
            toolContext,
            maxParallelTools: config.maxParallelTools,
            maxIterations: config.maxToolIterations,
            onToolCall: (observation) => {
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

          if (response.usage) {
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

          // Store assistant response
          config.sessionStore.addMessage(session.id, { role: 'assistant', content })

          await endpoint.send({
            text: userVisibleContent,
            sessionId: message.sessionId,
            endpointKind: message.endpointKind,
          })
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
        config.sessionStore.addMessage(session.id, { role: 'user', content: params.text })

        const toolContext: ToolExecutionContext = {
          sessionId: params.sessionId,
          endpointKind: params.endpointKind,
          searchPool: config.searchPool,
          shellPool: config.shellPool,
        }
        const memoryContext = await getMemoryContext(params.text)
        const llmMessages = memoryContext
          ? [{ role: 'system', content: memoryContext } as ChatMessage, ...session.messages]
          : session.messages

        try {
          const response = await chatWithTools(config.client, llmMessages, {
            model: config.model,
            ...mergedToolOptions,
            toolContext,
            maxParallelTools: config.maxParallelTools,
            maxIterations: config.maxToolIterations,
          })

          const content = response.choices[0]?.message?.content
          if (!content) return
          const userVisibleContent = toUserVisibleContent(content)

          config.sessionStore.addMessage(session.id, { role: 'assistant', content })

          await endpoint.send({
            text: userVisibleContent,
            sessionId: params.sessionId,
            endpointKind: params.endpointKind,
          })
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
