import { chatWithTools } from './llm/index.ts'
import { createLogger } from './logger.ts'
import { getToolDefinitions, executeTool as baseExecuteTool } from './tools/index.ts'

import type { ChatWithToolsClient } from './llm/index.ts'
import type { Endpoint, EndpointProfile, InboundMessage } from './endpoints/types.ts'
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
  baseSystemPrompt?: string
  logger?: LoggerConfig
  extraTools?: Tool[]
  skillRegistry?: SkillRegistry
}

export interface Dispatcher {
  registerEndpoint(endpoint: Endpoint): void
  handleInbound(message: InboundMessage): Promise<void>
  sendProactive(params: { sessionId: string, endpointKind: string, text: string }): Promise<void>
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

  const dispatcher: Dispatcher = {
    registerEndpoint(endpoint: Endpoint): void {
      endpoints.set(endpoint.profile.kind, endpoint)
    },

    async handleInbound(message: InboundMessage): Promise<void> {
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

      const toolContext = { sessionId: message.sessionId, endpointKind: message.endpointKind }

      try {
        const response = await chatWithTools(config.client, session.messages, {
          model: config.model,
          ...mergedToolOptions,
          toolContext,
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
    },

    async sendProactive(params: { sessionId: string, endpointKind: string, text: string }): Promise<void> {
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

      const toolContext = { sessionId: params.sessionId, endpointKind: params.endpointKind }

      try {
        const response = await chatWithTools(config.client, session.messages, {
          model: config.model,
          ...mergedToolOptions,
          toolContext,
        })

        const content = response.choices[0]?.message?.content
        if (!content) return

        config.sessionStore.addMessage(session.id, { role: 'assistant', content })

        await endpoint.send({
          text: content,
          sessionId: params.sessionId,
          endpointKind: params.endpointKind,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error({ sessionId: params.sessionId, error: errorMessage }, 'Error in proactive send')
        session.messages.pop()
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
