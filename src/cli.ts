#!/usr/bin/env node --experimental-strip-types

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { config } from 'dotenv'
import { Command } from 'commander'

// Load environment variables from .env file
config()
import { LLMClient } from './llm/index.ts'
import { createLogger } from './logger.ts'
import { buildPromptInput } from './prompt-input.ts'
import { createDispatcher } from './dispatcher.ts'
import { createInMemorySessionStore } from './sessions/store.ts'
import { createTelegramEndpoint } from './endpoints/telegram.ts'
import { createCliEndpoint } from './endpoints/cli.ts'
import { createCronScheduler } from './triggers/cron.ts'
import { createSkillRegistry } from './skills/index.ts'
import { MEMORY_TYPES, createMemoryService } from './memory/index.ts'
import { createScheduleMessageTools } from './tools/schedule-message.ts'
import { createMemoryTools } from './tools/memory-tools.ts'
import type { ChatMessage } from './llm/index.ts'
import type { MemoryType } from './memory/index.ts'

function parseTelegramAllowedUserIds(): number[] | undefined {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS
  if (!raw) return undefined
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean).map(Number)
  if (ids.some(Number.isNaN)) {
    console.error('Error: TELEGRAM_ALLOWED_USER_IDS contains non-numeric values.')
    process.exit(1)
  }
  return ids
}

function isMemoryType(value: unknown): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType)
}

async function confirmAction(question: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${question} (y/N): `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

function formatMemoryRows(rows: Array<{
  id: number
  type: string
  createdAt: string
  tokenCount: number
  content: string
}>): string {
  return rows.map(row => {
    const date = row.createdAt.slice(0, 19).replace('T', ' ')
    return `#${row.id} [${row.type}] (${date}, ${row.tokenCount} tokens)\n${row.content}`
  }).join('\n\n')
}

const program = new Command()

program
  .name('jarvis')
  .description('AI assistant CLI using synthetic.new API')
  .version('1.0.0')

program
  .command('chat')
  .description('Send a message to the LLM')
  .argument('[message]', 'Message to send')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-t, --temperature <temp>', 'Temperature (0.0-2.0)', '0.7')
  .option('--max-tokens <tokens>', 'Maximum tokens to generate')
  .option('-s, --system <prompt>', 'System prompt')
  .option('-f, --file <path>', 'Read prompt content from a file')
  .option('--stream', 'Stream the response', false)
  .option('--no-memory', 'Disable memory features for this invocation')
  .action(async (message, options) => {
    let memoryService: ReturnType<typeof createMemoryService> | undefined
    try {
      const model = options.model ?? process.env.DEFAULT_MODEL

      if (!model) {
        console.error('Error: Model is required. Either use -m/--model flag or set DEFAULT_MODEL environment variable.')
        console.error('\nRun "jarvis list-models" to see available models.')
        process.exit(1)
      }

      const client = new LLMClient({
        defaultModel: model,
      })

      if (options.memory) {
        memoryService = createMemoryService()
      }

      const messages: ChatMessage[] = []
      const summaryMessages: ChatMessage[] = []

      if (options.system) {
        messages.push({ role: 'system', content: options.system })
        summaryMessages.push({ role: 'system', content: options.system })
      }

      const prompt = await buildPromptInput({
        message,
        filePath: options.file,
      })

      if (memoryService) {
        const memoryContext = memoryService.getAutoContext(prompt)
        if (memoryContext) {
          messages.push({ role: 'system', content: memoryContext })
        }
      }

      messages.push({ role: 'user', content: prompt })
      summaryMessages.push({ role: 'user', content: prompt })

      if (options.stream) {
        process.stdout.write('Thinking...\n\n')
        let streamedContent = ''

        for await (const chunk of client.streamChat(messages, {
          temperature: parseFloat(options.temperature),
          max_tokens: options.maxTokens ? parseInt(options.maxTokens) : undefined,
        })) {
          const content = chunk.choices[0]?.delta?.content
          if (content) {
            streamedContent += content
            process.stdout.write(content)
          }
        }
        process.stdout.write('\n')

        if (memoryService && streamedContent.trim()) {
          summaryMessages.push({ role: 'assistant', content: streamedContent })
          await memoryService.summarizeAndStore({
            client,
            model,
            messages: summaryMessages,
            hadToolCalls: false,
            source: `chat ${new Date().toISOString()}`,
          })
        }
      } else {
        const response = await client.chat(messages, {
          temperature: parseFloat(options.temperature),
          max_tokens: options.maxTokens ? parseInt(options.maxTokens) : undefined,
        })

        const content = response.choices[0]?.message?.content ?? ''
        console.log(content)

        if (memoryService && content.trim()) {
          summaryMessages.push({ role: 'assistant', content })
          await memoryService.summarizeAndStore({
            client,
            model,
            messages: summaryMessages,
            hadToolCalls: false,
            source: `chat ${new Date().toISOString()}`,
          })
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        const msg = error.message.toLowerCase()
        if (msg.includes('model') && (msg.includes('not found') || msg.includes('404'))) {
          console.error('Error: Model not found or not accessible.')
          console.error('\nRun "jarvis list-models" to see available models.')
        } else {
          console.error('Error:', error.message)
        }
        process.exit(1)
      }
      throw error
    } finally {
      memoryService?.close()
    }
  })

program
  .command('list-models')
  .description('List available models')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      const client = new LLMClient()
      const models = await client.listModels()

      if (options.json) {
        console.log(JSON.stringify(models, null, 2))
      } else {
        console.log('Available models:\n')
        for (const model of models) {
          console.log(`  ${model.id}`)
        }
        console.log(`\nTotal: ${models.length} models`)
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error:', error.message)
        process.exit(1)
      }
      throw error
    }
  })

const memoryCommand = program
  .command('memory')
  .description('Inspect and manage persistent Jarvis memory')

memoryCommand
  .command('search')
  .description('Search memories by keyword')
  .argument('[query]', 'Search query (empty query lists recent memories)', '')
  .option('--type <type>', `Filter by memory type: ${MEMORY_TYPES.join(', ')}`)
  .option('--limit <n>', 'Maximum number of results', '5')
  .action(async (query, options) => {
    const limit = parseInt(options.limit)
    if (Number.isNaN(limit) || limit <= 0) {
      console.error('Error: --limit must be a positive number.')
      process.exit(1)
    }

    if (options.type && !isMemoryType(options.type)) {
      console.error(`Error: --type must be one of: ${MEMORY_TYPES.join(', ')}`)
      process.exit(1)
    }

    const memoryService = createMemoryService()
    try {
      const results = memoryService.search({
        query,
        type: options.type,
        limit,
      })

      if (results.length === 0) {
        console.log('No memories found.')
        return
      }

      console.log(formatMemoryRows(results))
    } finally {
      memoryService.close()
    }
  })

memoryCommand
  .command('list')
  .description('List recent memories')
  .option('--type <type>', `Filter by memory type: ${MEMORY_TYPES.join(', ')}`)
  .option('--limit <n>', 'Maximum number of results', '10')
  .action(async (options) => {
    const limit = parseInt(options.limit)
    if (Number.isNaN(limit) || limit <= 0) {
      console.error('Error: --limit must be a positive number.')
      process.exit(1)
    }

    if (options.type && !isMemoryType(options.type)) {
      console.error(`Error: --type must be one of: ${MEMORY_TYPES.join(', ')}`)
      process.exit(1)
    }

    const memoryService = createMemoryService()
    try {
      const rows = memoryService.getRecent(limit, options.type)
      if (rows.length === 0) {
        console.log('No memories stored.')
        return
      }

      console.log(formatMemoryRows(rows))
    } finally {
      memoryService.close()
    }
  })

memoryCommand
  .command('stats')
  .description('Show memory usage statistics')
  .action(async () => {
    const memoryService = createMemoryService()
    try {
      const stats = memoryService.getStats()
      console.log(`DB: ${stats.dbPath}`)
      console.log(`Size: ${stats.dbSizeBytes} bytes`)
      console.log(`Total memories: ${stats.totalCount}`)
      console.log(`Total estimated tokens: ${stats.totalTokenCount}`)
      console.log('By type:')
      for (const type of MEMORY_TYPES) {
        console.log(`  - ${type}: ${stats.byType[type]}`)
      }
    } finally {
      memoryService.close()
    }
  })

memoryCommand
  .command('clear')
  .description('Delete memories (all or by type)')
  .option('--type <type>', `Only clear one memory type: ${MEMORY_TYPES.join(', ')}`)
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    if (options.type && !isMemoryType(options.type)) {
      console.error(`Error: --type must be one of: ${MEMORY_TYPES.join(', ')}`)
      process.exit(1)
    }

    if (!options.yes) {
      const target = options.type ? `all "${options.type}" memories` : 'ALL memories'
      const confirmed = await confirmAction(`Delete ${target}?`)
      if (!confirmed) {
        console.log('Cancelled.')
        return
      }
    }

    const memoryService = createMemoryService()
    try {
      const deleted = memoryService.clear(options.type)
      console.log(`Deleted ${deleted} memorie(s).`)
    } finally {
      memoryService.close()
    }
  })

memoryCommand
  .command('export')
  .description('Export all memories as JSON')
  .action(async () => {
    const memoryService = createMemoryService()
    try {
      const rows = memoryService.exportAll()
      console.log(JSON.stringify(rows, null, 2))
    } finally {
      memoryService.close()
    }
  })

program
  .command('chat-with-tools')
  .description('Chat with tool calling enabled')
  .argument('[message]', 'Message to send')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-t, --temperature <temp>', 'Temperature (0.0-2.0)', '0.7')
  .option('--max-tokens <tokens>', 'Maximum tokens to generate')
  .option('-s, --system <prompt>', 'System prompt')
  .option('-f, --file <path>', 'Read prompt content from a file')
  .option('--log-level <level>', 'Log level for tool-call logs', process.env.JARVIS_LOG_LEVEL ?? 'info')
  .option('--log-file <path>', 'Also write tool-call logs to a file')
  .option('--no-memory', 'Disable memory features for this invocation')
  .action(async (message, options) => {
    let memoryService: ReturnType<typeof createMemoryService> | undefined
    let dispatcher: ReturnType<typeof createDispatcher> | undefined
    try {
      const model = options.model ?? process.env.DEFAULT_MODEL

      if (!model) {
        console.error('Error: Model is required. Either use -m/--model flag or set DEFAULT_MODEL environment variable.')
        console.error('\nRun "jarvis list-models" to see available models.')
        process.exit(1)
      }

      const client = new LLMClient({ defaultModel: model })
      const sessionStore = createInMemorySessionStore()
      const cliEndpoint = createCliEndpoint()
      const loggerConfig = { level: options.logLevel, filePath: options.logFile }
      const logger = createLogger(loggerConfig)

      if (options.memory) {
        memoryService = createMemoryService({ logger })
      }
      const memoryTools = memoryService ? createMemoryTools(memoryService) : []

      dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        baseSystemPrompt: options.system,
        logger: loggerConfig,
        extraTools: memoryTools,
        memoryService,
      })
      dispatcher.registerEndpoint(cliEndpoint)

      const prompt = await buildPromptInput({
        message,
        filePath: options.file,
      })

      console.log('Thinking...\n')

      await dispatcher.handleInbound({
        text: prompt,
        sessionId: 'cli:default',
        endpointKind: 'cli',
        timestamp: new Date(),
      })
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error:', error.message)
        process.exit(1)
      }
      throw error
    } finally {
      await dispatcher?.waitForIdle(3000)
      await dispatcher?.flushMemoryWrites(3000)
      memoryService?.close()
    }
  })

program
  .command('telegram')
  .description('Start Telegram bot (long-polling mode)')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-s, --system-prompt <prompt>', 'System prompt for the bot')
  .option('--log-level <level>', 'Log level', process.env.JARVIS_LOG_LEVEL ?? 'info')
  .option('--log-file <path>', 'Also write logs to a file')
  .option('--no-memory', 'Disable memory features for this invocation')
  .action(async (options) => {
    let memoryService: ReturnType<typeof createMemoryService> | undefined
    try {
      const model = options.model ?? process.env.DEFAULT_MODEL

      if (!model) {
        console.error('Error: Model is required. Either use -m/--model flag or set DEFAULT_MODEL environment variable.')
        process.exit(1)
      }

      const token = process.env.TELEGRAM_BOT_TOKEN
      if (!token) {
        console.error('Error: TELEGRAM_BOT_TOKEN environment variable is required.')
        console.error('\nGet a bot token from @BotFather on Telegram and add it to your .env file.')
        process.exit(1)
      }

      const allowedUserIds = parseTelegramAllowedUserIds()
      const client = new LLMClient({ defaultModel: model })
      const sessionStore = createInMemorySessionStore()
      const telegramEndpoint = createTelegramEndpoint({
        token,
        allowedUserIds,
        logLevel: options.logLevel,
        logFile: options.logFile,
      })

      const loggerConfig = { level: options.logLevel, filePath: options.logFile }
      const telegramLogger = createLogger(loggerConfig)
      if (options.memory) {
        memoryService = createMemoryService({ logger: telegramLogger })
      }
      const memoryTools = memoryService ? createMemoryTools(memoryService) : []

      const skillRegistry = createSkillRegistry()
      skillRegistry.register({
        name: 'reminder',
        description: 'Set, list, and cancel time-based reminders',
        tools: ['schedule_message', 'list_scheduled_messages', 'cancel_scheduled_message'],
        filePath: 'src/skills/reminder.md',
      })

      // Create schedule-message tools — dispatcher ref captured after creation
      let dispatcherRef: { sendProactive: (p: { sessionId: string, endpointKind: string, text: string }) => Promise<void> }
      const scheduleHandle = createScheduleMessageTools({
        sendProactive: (params) => dispatcherRef.sendProactive(params),
        dataDir: 'data',
        logger: telegramLogger,
      })

      const dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        baseSystemPrompt: options.systemPrompt,
        logger: loggerConfig,
        extraTools: [...scheduleHandle.tools, ...memoryTools],
        skillRegistry,
        memoryService,
      })
      dispatcherRef = dispatcher
      dispatcher.registerEndpoint(telegramEndpoint)

      await scheduleHandle.initialize()
      const stop = await dispatcher.start()

      let isShuttingDown = false
      const shutdown = async () => {
        if (isShuttingDown) return
        isShuttingDown = true

        scheduleHandle.shutdown()
        stop()
        await dispatcher.waitForIdle(5000)
        await dispatcher.flushMemoryWrites(5000)
        memoryService?.close()
        process.exit(0)
      }
      process.once('SIGINT', () => { void shutdown() })
      process.once('SIGTERM', () => { void shutdown() })
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error:', error.message)
        process.exit(1)
      }
      throw error
    }
  })

program
  .command('serve')
  .description('Start all endpoints and cron triggers as a long-running service')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-s, --system-prompt <prompt>', 'System prompt')
  .option('--log-level <level>', 'Log level', process.env.JARVIS_LOG_LEVEL ?? 'info')
  .option('--log-file <path>', 'Also write logs to a file')
  .option('--cron <tasks>', 'Cron tasks as JSON array: [{"name","intervalMs","targetSessionId","targetEndpointKind","prompt"}]')
  .option('--no-memory', 'Disable memory features for this invocation')
  .action(async (options) => {
    let memoryService: ReturnType<typeof createMemoryService> | undefined
    try {
      const model = options.model ?? process.env.DEFAULT_MODEL

      if (!model) {
        console.error('Error: Model is required. Either use -m/--model flag or set DEFAULT_MODEL environment variable.')
        process.exit(1)
      }

      const client = new LLMClient({ defaultModel: model })
      const sessionStore = createInMemorySessionStore()
      const loggerConfig = { level: options.logLevel, filePath: options.logFile }
      const logger = createLogger(loggerConfig)
      if (options.memory) {
        memoryService = createMemoryService({ logger })
      }
      const memoryTools = memoryService ? createMemoryTools(memoryService) : []

      const skillRegistry = createSkillRegistry()
      skillRegistry.register({
        name: 'reminder',
        description: 'Set, list, and cancel time-based reminders',
        tools: ['schedule_message', 'list_scheduled_messages', 'cancel_scheduled_message'],
        filePath: 'src/skills/reminder.md',
      })

      // Create schedule-message tools — dispatcher ref captured after creation
      let dispatcherRef: { sendProactive: (p: { sessionId: string, endpointKind: string, text: string }) => Promise<void> }
      const scheduleHandle = createScheduleMessageTools({
        sendProactive: (params) => dispatcherRef.sendProactive(params),
        dataDir: 'data',
        logger,
      })

      const dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        baseSystemPrompt: options.systemPrompt,
        logger: loggerConfig,
        extraTools: [...scheduleHandle.tools, ...memoryTools],
        skillRegistry,
        memoryService,
      })
      dispatcherRef = dispatcher

      // Register Telegram endpoint if token is available
      const token = process.env.TELEGRAM_BOT_TOKEN
      if (token) {
        const allowedUserIds = parseTelegramAllowedUserIds()
        const telegramEndpoint = createTelegramEndpoint({
          token,
          allowedUserIds,
          logLevel: options.logLevel,
          logFile: options.logFile,
        })
        dispatcher.registerEndpoint(telegramEndpoint)
        logger.info('Telegram endpoint registered')
      } else {
        logger.warn('TELEGRAM_BOT_TOKEN not set, skipping Telegram endpoint')
      }

      // Initialize tools that need startup
      await scheduleHandle.initialize()

      // Start all endpoints
      const stopEndpoints = await dispatcher.start()

      // Set up cron tasks if provided
      let cronScheduler: ReturnType<typeof createCronScheduler> | undefined
      if (options.cron) {
        try {
          const tasks = JSON.parse(options.cron)
          cronScheduler = createCronScheduler({
            tasks,
            dispatcher,
            logger: loggerConfig,
          })
          cronScheduler.start()
          logger.info({ taskCount: tasks.length }, 'Cron scheduler started')
        } catch (parseError) {
          console.error('Error: Invalid --cron JSON:', parseError instanceof Error ? parseError.message : String(parseError))
          process.exit(1)
        }
      }

      console.log('Jarvis serve mode started (Ctrl+C to stop)')

      let isShuttingDown = false
      const shutdown = async () => {
        if (isShuttingDown) return
        isShuttingDown = true
        logger.info('Shutting down...')
        cronScheduler?.stop()
        scheduleHandle.shutdown()
        stopEndpoints()
        await dispatcher.waitForIdle(5000)
        await dispatcher.flushMemoryWrites(5000)
        memoryService?.close()
        process.exit(0)
      }
      process.once('SIGINT', () => { void shutdown() })
      process.once('SIGTERM', () => { void shutdown() })
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error:', error.message)
        process.exit(1)
      }
      throw error
    }
  })

program.parse()
