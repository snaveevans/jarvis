import { createInterface } from 'node:readline/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stdin as input, stdout as output } from 'node:process'

import { Command } from 'commander'

import { runUpdate } from './commands/update.ts'
import { runUninstall } from './commands/uninstall.ts'

import { LLMClient } from './llm/index.ts'
import { createLogger } from './logger.ts'
import { buildPromptInput } from './prompt-input.ts'
import { createDispatcher } from './dispatcher.ts'
import { createInMemorySessionStore, createSessionHistoryStore } from './sessions/index.ts'
import { createTelegramEndpoint } from './endpoints/telegram.ts'
import { createCliEndpoint } from './endpoints/cli.ts'
import { createCronScheduler } from './triggers/cron.ts'
import { createSkillRegistry } from './skills/index.ts'
import { MEMORY_TYPES, createMemoryService, createEvictionEvaluator } from './memory/index.ts'
import { createMemoryWorkerClient, createSearchWorkerPool } from './workers/index.ts'
import { createShellPool } from './shell/index.ts'
import { createScheduleMessageTools } from './tools/schedule-message.ts'
import { createMemoryTools } from './tools/memory-tools.ts'
import { createIntrospectTool } from './tools/introspect.ts'
import { createReadLogsTool } from './tools/read-logs.ts'
import { createHealthCheckTool } from './tools/health-check.ts'
import { createWebSearchTool } from './tools/web-search.ts'
import { createSkillManagerTools } from './tools/skill-manager.ts'
import { createEventStore } from './telemetry/event-store.ts'
import { getConfig, logConfig } from './config.ts'
import { getToolDefinitions } from './tools/index.ts'
import type { ChatMessage } from './llm/index.ts'
import type { MemoryService, MemoryType } from './memory/index.ts'
import type { Tool } from './tools/types.ts'
import type { SkillRegistry } from './skills/index.ts'
import type { SessionHistoryStore } from './sessions/index.ts'

function parseTelegramAllowedUserIds(configValue: number[] | string | undefined): number[] | undefined {
  if (!configValue) return undefined
  const ids = Array.isArray(configValue) 
    ? configValue 
    : configValue.split(',').map(s => s.trim()).filter(Boolean).map(Number)
  if (ids.some(Number.isNaN)) {
    console.error('Error: telegram.allowedUserIds contains non-numeric values.')
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

const CUSTOM_SKILLS_DIR = path.join(process.cwd(), 'data/skills')

function registerBuiltInSkills(skillRegistry: SkillRegistry, includeReminder: boolean): void {
  if (includeReminder) {
    skillRegistry.register({
      name: 'reminder',
      description: 'Set, list, and cancel time-based reminders',
      tools: ['schedule_message', 'list_scheduled_messages', 'cancel_scheduled_message'],
      filePath: 'src/skills/reminder.md',
    })
  }

  skillRegistry.register({
    name: 'introspection',
    description: 'Self-diagnosis using introspect, read_logs, and health_check tools',
    tools: ['introspect', 'read_logs', 'health_check'],
    filePath: 'src/skills/introspection.md',
  })
}

function createSkillTools(
  skillRegistry: SkillRegistry,
  enabledTools: Tool[]
): Tool[] {
  const allowedToolNames = new Set<string>([
    ...getToolDefinitions().map((def) => def.function.name),
    ...enabledTools.map((tool) => tool.name),
    'create_skill',
    'list_skills',
    'remove_skill',
  ])

  return createSkillManagerTools({
    skillRegistry,
    skillsDir: CUSTOM_SKILLS_DIR,
    allowedToolNames: Array.from(allowedToolNames),
  })
}

function createHistoryStore(config: Awaited<ReturnType<typeof getConfig>>): SessionHistoryStore | undefined {
  if (!config.history.enabled) {
    return undefined
  }
  return createSessionHistoryStore({
    dbPath: config.history.dbPath,
  })
}

function createEvictionHandler(params: {
  client: LLMClient
  model: string
  memoryService?: MemoryService
  logger: ReturnType<typeof createLogger>
  historyStore?: SessionHistoryStore
  retentionHours: number
}): ((sessionId: string, evicted: ChatMessage[], info?: { startSeq: number, endSeq: number }) => void) | undefined {
  const { client, model, memoryService, logger, historyStore, retentionHours } = params

  if (!memoryService && !historyStore) {
    return undefined
  }

  const evaluator = memoryService
    ? createEvictionEvaluator({
      client,
      model,
      memoryService,
      logger,
      onComplete: ({ status, meta }) => {
        const batchId = meta?.batchId
        if (!historyStore || !batchId) return
        historyStore.markBatchStatus(batchId, status)
        if (status === 'processed') {
          const purgedCount = historyStore.purgeProcessedMessagesOlderThan(retentionHours)
          if (purgedCount > 0) {
            logger.info({ purgedCount }, 'Purged processed historical session messages')
          }
        }
      },
    })
    : undefined

  return (sessionId, evicted, info) => {
    let batchId: number | undefined
    if (
      historyStore &&
      info &&
      Number.isFinite(info.startSeq) &&
      Number.isFinite(info.endSeq) &&
      info.startSeq > 0 &&
      info.endSeq >= info.startSeq
    ) {
      batchId = historyStore.createEvictionBatch(sessionId, info.startSeq, info.endSeq)
    }

    if (evaluator) {
      evaluator(sessionId, evicted, {
        ...info,
        batchId,
      })
      return
    }

    if (historyStore && batchId) {
      historyStore.markBatchStatus(batchId, 'processed')
      const purgedCount = historyStore.purgeProcessedMessagesOlderThan(retentionHours)
      if (purgedCount > 0) {
        logger.info({ purgedCount }, 'Purged processed historical session messages')
      }
    }
  }
}


const jarvisHome = process.env.JARVIS_HOME || process.cwd()
const pkgJson = JSON.parse(readFileSync(path.join(jarvisHome, 'package.json'), 'utf-8'))

const program = new Command()

program
  .name('jarvis')
  .description('AI assistant CLI using synthetic.new API')
  .version(pkgJson.version)

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
      const config = await getConfig()
      const model = options.model ?? config.llm.defaultModel

      if (!model) {
        console.error('Error: Model is required. Either use -m/--model flag or set DEFAULT_MODEL environment variable.')
        console.error('\nRun "jarvis list-models" to see available models.')
        process.exit(1)
      }

      const client = new LLMClient({
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.baseUrl,
        defaultModel: model,
        provider: config.llm.provider,
      })

      if (options.memory) {
        memoryService = createMemoryService({
          memoryDir: config.memory.dir,
          archiveRetentionDays: config.memory.archiveRetentionDays,
        })
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
        const memoryContext = await memoryService.getAutoContext(prompt)
        if (memoryContext) {
          messages.push({ role: 'system', content: memoryContext })
        }
      }

      messages.push({ role: 'user', content: prompt })
      summaryMessages.push({ role: 'user', content: prompt })

      if (options.stream) {
        process.stdout.write('Thinking...\n\n')
        let streamedContent = ''
        let displayedContent = ''

        for await (const chunk of client.streamChat(messages, {
          temperature: parseFloat(options.temperature),
          max_tokens: options.maxTokens ? parseInt(options.maxTokens) : undefined,
        })) {
          const content = chunk.choices[0]?.delta?.content
          if (content) {
            streamedContent += content
            const nextVisible = client.toUserVisibleContent(streamedContent)
            const delta = nextVisible.slice(displayedContent.length)
            if (delta) {
              process.stdout.write(delta)
              displayedContent = nextVisible
            }
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
        console.log(client.toUserVisibleContent(content))

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
      const config = await getConfig()
      const client = new LLMClient({
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.baseUrl,
        provider: config.llm.provider,
      })
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

program
  .command('config')
  .description('Show current configuration (API keys redacted)')
  .action(async () => {
    try {
      const config = await getConfig()
      const safeConfig = {
        llm: {
          provider: config.llm.provider,
          baseUrl: config.llm.baseUrl,
          defaultModel: config.llm.defaultModel,
          apiKey: config.llm.apiKey ? `${config.llm.apiKey.slice(0, 8)}...` : '(not set)',
        },
        memory: {
          enabled: config.memory.enabled,
          dir: config.memory.dir,
        },
        search: {
          provider: config.search.provider,
        },
      }
      console.log(JSON.stringify(safeConfig, null, 2))
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

    const config = await getConfig()
    const memoryService = createMemoryService({
      memoryDir: config.memory.dir,
      archiveRetentionDays: config.memory.archiveRetentionDays,
    })
    try {
      const results = await memoryService.search({
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

    const config = await getConfig()
    const memoryService = createMemoryService({
      memoryDir: config.memory.dir,
      archiveRetentionDays: config.memory.archiveRetentionDays,
    })
    try {
      const rows = await memoryService.getRecent(limit, options.type)
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
    const config = await getConfig()
    const memoryService = createMemoryService({
      memoryDir: config.memory.dir,
      archiveRetentionDays: config.memory.archiveRetentionDays,
    })
    try {
      const stats = await memoryService.getStats()
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

    const config = await getConfig()
    const memoryService = createMemoryService({
      memoryDir: config.memory.dir,
      archiveRetentionDays: config.memory.archiveRetentionDays,
    })
    try {
      const deleted = await memoryService.clear(options.type)
      console.log(`Deleted ${deleted} memorie(s).`)
    } finally {
      memoryService.close()
    }
  })

memoryCommand
  .command('export')
  .description('Export all memories as JSON')
  .action(async () => {
    const config = await getConfig()
    const memoryService = createMemoryService({
      memoryDir: config.memory.dir,
      archiveRetentionDays: config.memory.archiveRetentionDays,
    })
    try {
      const rows = await memoryService.exportAll()
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
  .option('--log-level <level>', 'Log level for tool-call logs', 'info')
  .option('--log-file <path>', 'Also write tool-call logs to a file')
  .option('--no-memory', 'Disable memory features for this invocation')
  .action(async (message, options) => {
    let memoryService: ReturnType<typeof createMemoryService> | undefined
    let dispatcher: ReturnType<typeof createDispatcher> | undefined
    let historyStore: SessionHistoryStore | undefined
    try {
      const config = await getConfig()
      const model = options.model ?? config.llm.defaultModel

      if (!model) {
        console.error('Error: Model is required. Either use -m/--model flag or set DEFAULT_MODEL environment variable.')
        console.error('\nRun "jarvis list-models" to see available models.')
        process.exit(1)
      }

      const client = new LLMClient({
        apiKey: config.llm.apiKey,
        defaultModel: model,
        baseUrl: config.llm.baseUrl,
        provider: config.llm.provider,
      })
      const loggerConfig = { level: options.logLevel ?? config.logging.level, filePath: options.logFile ?? config.logging.file }
      const logger = createLogger(loggerConfig)

      if (options.memory) {
        memoryService = createMemoryService({
          logger,
          memoryDir: config.memory.dir,
          archiveRetentionDays: config.memory.archiveRetentionDays,
        })
      }

      historyStore = createHistoryStore(config)
      if (historyStore) {
        historyStore.purgeProcessedMessagesOlderThan(config.history.retentionHours)
      }

      const onEvict = createEvictionHandler({
        client,
        model,
        memoryService,
        logger,
        historyStore,
        retentionHours: config.history.retentionHours,
      })
      const sessionStore = createInMemorySessionStore({
        onEvict,
        historyStore,
        historyReplayMaxMessages: config.history.rehydrateMaxMessages,
      })
      const cliEndpoint = createCliEndpoint()
      const memoryTools = memoryService ? createMemoryTools(memoryService) : []
      const skillRegistry = createSkillRegistry()
      registerBuiltInSkills(skillRegistry, false)

      const processStartMs = Date.now()
      const eventStore = createEventStore(config.tools.eventStoreSize)
      const logFilePath = options.logFile ?? config.logging.file ?? ''
      const webSearchTools = [
        createWebSearchTool({
          search: config.search,
          syntheticApiKeyFallback: config.llm.providers.synthetic.apiKey,
        }),
      ]
      const introspectionTools = [
        createIntrospectTool({ eventStore, sessionStore, memoryService, config, processStartMs }),
        ...(logFilePath ? [createReadLogsTool({ logFilePath })] : []),
        createHealthCheckTool({ client, memoryService, sessionStore, processStartMs }),
      ]
      const enabledTools = [...memoryTools, ...webSearchTools, ...introspectionTools]
      const skillTools = createSkillTools(skillRegistry, enabledTools)
      const reloadResult = await skillRegistry.reloadCustomFromDir(CUSTOM_SKILLS_DIR)
      if (reloadResult.errors.length > 0) {
        logger.warn({ errors: reloadResult.errors }, 'Failed to load one or more custom skills')
      }

      dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        providerName: config.llm.provider,
        baseSystemPrompt: options.system ?? (config.llm.defaultPrompt || undefined),
        logger: loggerConfig,
        extraTools: [...enabledTools, ...skillTools],
        skillRegistry,
        memoryService,
        eventStore,
        maxToolIterations: config.tools.maxIterations,
        maxParallelTools: config.tools.maxParallel,
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
      historyStore?.close()
    }
  })

program
  .command('telegram')
  .description('Start Telegram bot (long-polling mode)')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-s, --system-prompt <prompt>', 'System prompt for the bot')
  .option('--log-level <level>', 'Log level', 'info')
  .option('--log-file <path>', 'Also write logs to a file')
  .option('--no-memory', 'Disable memory features for this invocation')
  .action(async (options) => {
    let memoryService: MemoryService | undefined
    let historyStore: SessionHistoryStore | undefined
    try {
      const config = await getConfig()
      const model = options.model ?? config.llm.defaultModel

      if (!model) {
        console.error('Error: Model is required. Either use -m/--model flag or set DEFAULT_MODEL environment variable.')
        process.exit(1)
      }

      const token = config.telegram.botToken
      if (!token) {
        console.error('Error: TELEGRAM_BOT_TOKEN environment variable is required.')
        console.error('\nGet a bot token from @BotFather on Telegram and add it to your .env file.')
        process.exit(1)
      }

      const allowedUserIds = parseTelegramAllowedUserIds(config.telegram.allowedUserIds)
      const client = new LLMClient({
        apiKey: config.llm.apiKey,
        defaultModel: model,
        baseUrl: config.llm.baseUrl,
        provider: config.llm.provider,
      })
      const loggerConfig = { level: options.logLevel ?? config.logging.level, filePath: options.logFile ?? config.logging.file }
      const telegramLogger = createLogger(loggerConfig)
      logConfig(telegramLogger, config)
      if (options.memory) {
        memoryService = createMemoryWorkerClient({
          logger: telegramLogger,
          memoryDir: config.memory.dir,
          archiveRetentionDays: config.memory.archiveRetentionDays,
        })
      }

      historyStore = createHistoryStore(config)
      if (historyStore) {
        historyStore.purgeProcessedMessagesOlderThan(config.history.retentionHours)
      }

      const onEvict = createEvictionHandler({
        client,
        model,
        memoryService,
        logger: telegramLogger,
        historyStore,
        retentionHours: config.history.retentionHours,
      })
      const sessionStore = createInMemorySessionStore({
        onEvict,
        historyStore,
        historyReplayMaxMessages: config.history.rehydrateMaxMessages,
      })
      const telegramEndpoint = createTelegramEndpoint({
        token,
        allowedUserIds,
        logLevel: options.logLevel,
        logFile: options.logFile,
      })

      const memoryTools = memoryService ? createMemoryTools(memoryService) : []

      const processStartMs = Date.now()
      const eventStore = createEventStore(config.tools.eventStoreSize)
      const logFilePath = options.logFile ?? config.logging.file ?? ''
      const webSearchTools = [
        createWebSearchTool({
          search: config.search,
          syntheticApiKeyFallback: config.llm.providers.synthetic.apiKey,
        }),
      ]
      const introspectionTools = [
        createIntrospectTool({ eventStore, sessionStore, memoryService, config, processStartMs }),
        ...(logFilePath ? [createReadLogsTool({ logFilePath })] : []),
        createHealthCheckTool({ client, memoryService, sessionStore, processStartMs }),
      ]

      const skillRegistry = createSkillRegistry()
      registerBuiltInSkills(skillRegistry, true)

      // Create schedule-message tools — dispatcher ref captured after creation
      let dispatcherRef: {
        sendProactive: (p: { sessionId: string, endpointKind: string, text: string, skipLLM?: boolean }) => Promise<void>
      }
      const scheduleHandle = createScheduleMessageTools({
        sendProactive: (params) => dispatcherRef.sendProactive(params),
        dataDir: 'data',
        logger: telegramLogger,
      })
      const enabledTools = [...scheduleHandle.tools, ...memoryTools, ...webSearchTools, ...introspectionTools]
      const skillTools = createSkillTools(skillRegistry, enabledTools)
      const reloadResult = await skillRegistry.reloadCustomFromDir(CUSTOM_SKILLS_DIR)
      if (reloadResult.errors.length > 0) {
        telegramLogger.warn({ errors: reloadResult.errors }, 'Failed to load one or more custom skills')
      }

      const searchPool = createSearchWorkerPool({ logger: telegramLogger })
      const shellPool = createShellPool()

      const dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        providerName: config.llm.provider,
        baseSystemPrompt: options.systemPrompt ?? (config.llm.defaultPrompt || undefined),
        logger: loggerConfig,
        extraTools: [...enabledTools, ...skillTools],
        skillRegistry,
        memoryService,
        eventStore,
        maxToolIterations: config.tools.maxIterations,
        maxParallelTools: config.tools.maxParallel,
        searchPool,
        shellPool,
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
        await memoryService?.close()
        historyStore?.close()
        await searchPool.shutdown()
        shellPool.shutdown()
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
  .option('--log-level <level>', 'Log level', 'info')
  .option('--log-file <path>', 'Also write logs to a file')
  .option('--cron <tasks>', 'Cron tasks as JSON array: [{"name","intervalMs","targetSessionId","targetEndpointKind","prompt"}]')
  .option('--no-memory', 'Disable memory features for this invocation')
  .action(async (options) => {
    let memoryService: MemoryService | undefined
    let historyStore: SessionHistoryStore | undefined
    try {
      const config = await getConfig()
      const model = options.model ?? config.llm.defaultModel

      if (!model) {
        console.error('Error: Model is required. Either use -m/--model flag or set DEFAULT_MODEL environment variable.')
        process.exit(1)
      }

      const client = new LLMClient({
        apiKey: config.llm.apiKey,
        defaultModel: model,
        baseUrl: config.llm.baseUrl,
        provider: config.llm.provider,
      })
      const loggerConfig = { level: options.logLevel ?? config.logging.level, filePath: options.logFile ?? config.logging.file }
      const logger = createLogger(loggerConfig)
      logConfig(logger, config)
      if (options.memory) {
        memoryService = createMemoryWorkerClient({
          logger,
          memoryDir: config.memory.dir,
          archiveRetentionDays: config.memory.archiveRetentionDays,
        })
      }

      historyStore = createHistoryStore(config)
      if (historyStore) {
        historyStore.purgeProcessedMessagesOlderThan(config.history.retentionHours)
      }

      const onEvict = createEvictionHandler({
        client,
        model,
        memoryService,
        logger,
        historyStore,
        retentionHours: config.history.retentionHours,
      })
      const sessionStore = createInMemorySessionStore({
        onEvict,
        historyStore,
        historyReplayMaxMessages: config.history.rehydrateMaxMessages,
      })
      const memoryTools = memoryService ? createMemoryTools(memoryService) : []

      const processStartMs = Date.now()
      const eventStore = createEventStore(config.tools.eventStoreSize)
      const logFilePath = options.logFile ?? config.logging.file ?? ''
      const webSearchTools = [
        createWebSearchTool({
          search: config.search,
          syntheticApiKeyFallback: config.llm.providers.synthetic.apiKey,
        }),
      ]
      const introspectionTools = [
        createIntrospectTool({ eventStore, sessionStore, memoryService, config, processStartMs }),
        ...(logFilePath ? [createReadLogsTool({ logFilePath })] : []),
        createHealthCheckTool({ client, memoryService, sessionStore, processStartMs }),
      ]

      const skillRegistry = createSkillRegistry()
      registerBuiltInSkills(skillRegistry, true)

      // Create schedule-message tools — dispatcher ref captured after creation
      let dispatcherRef: {
        sendProactive: (p: { sessionId: string, endpointKind: string, text: string, skipLLM?: boolean }) => Promise<void>
      }
      const scheduleHandle = createScheduleMessageTools({
        sendProactive: (params) => dispatcherRef.sendProactive(params),
        dataDir: 'data',
        logger,
      })
      const enabledTools = [...scheduleHandle.tools, ...memoryTools, ...webSearchTools, ...introspectionTools]
      const skillTools = createSkillTools(skillRegistry, enabledTools)
      const reloadResult = await skillRegistry.reloadCustomFromDir(CUSTOM_SKILLS_DIR)
      if (reloadResult.errors.length > 0) {
        logger.warn({ errors: reloadResult.errors }, 'Failed to load one or more custom skills')
      }

      const searchPool = createSearchWorkerPool({ logger })
      const shellPool = createShellPool()

      const dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        providerName: config.llm.provider,
        baseSystemPrompt: options.systemPrompt ?? (config.llm.defaultPrompt || undefined),
        logger: loggerConfig,
        extraTools: [...enabledTools, ...skillTools],
        skillRegistry,
        memoryService,
        eventStore,
        maxToolIterations: config.tools.maxIterations,
        maxParallelTools: config.tools.maxParallel,
        searchPool,
        shellPool,
      })
      dispatcherRef = dispatcher

      // Register Telegram endpoint if token is available
      const token = config.telegram.botToken
      if (token) {
        const allowedUserIds = parseTelegramAllowedUserIds(config.telegram.allowedUserIds)
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
        await memoryService?.close()
        historyStore?.close()
        await searchPool.shutdown()
        shellPool.shutdown()
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
  .command('update')
  .description('Update Jarvis to the latest version (git pull + npm install)')
  .action(async () => {
    await runUpdate()
  })

program
  .command('uninstall')
  .description('Remove Jarvis PATH entries and print cleanup instructions')
  .action(async () => {
    await runUninstall()
  })

program.parse()
