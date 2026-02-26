#!/usr/bin/env node --experimental-strip-types

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
import type { ChatMessage } from './llm/index.ts'

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
  .action(async (message, options) => {
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

      const messages: ChatMessage[] = []

      if (options.system) {
        messages.push({ role: 'system', content: options.system })
      }

      const prompt = await buildPromptInput({
        message,
        filePath: options.file,
      })

      messages.push({ role: 'user', content: prompt })

      if (options.stream) {
        process.stdout.write('Thinking...\n\n')

        for await (const chunk of client.streamChat(messages, {
          temperature: parseFloat(options.temperature),
          max_tokens: options.maxTokens ? parseInt(options.maxTokens) : undefined,
        })) {
          const content = chunk.choices[0]?.delta?.content
          if (content) {
            process.stdout.write(content)
          }
        }
        process.stdout.write('\n')
      } else {
        const response = await client.chat(messages, {
          temperature: parseFloat(options.temperature),
          max_tokens: options.maxTokens ? parseInt(options.maxTokens) : undefined,
        })

        console.log(response.choices[0]?.message?.content)
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
  .action(async (message, options) => {
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

      const dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        baseSystemPrompt: options.system,
        logger: { level: options.logLevel, filePath: options.logFile },
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
    }
  })

program
  .command('telegram')
  .description('Start Telegram bot (long-polling mode)')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-s, --system-prompt <prompt>', 'System prompt for the bot')
  .option('--log-level <level>', 'Log level', process.env.JARVIS_LOG_LEVEL ?? 'info')
  .option('--log-file <path>', 'Also write logs to a file')
  .action(async (options) => {
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

      const dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        baseSystemPrompt: options.systemPrompt,
        logger: { level: options.logLevel, filePath: options.logFile },
      })
      dispatcher.registerEndpoint(telegramEndpoint)

      const stop = await dispatcher.start()

      const shutdown = () => {
        stop()
        process.exit(0)
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
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
  .action(async (options) => {
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

      const dispatcher = createDispatcher({
        client,
        sessionStore,
        model,
        baseSystemPrompt: options.systemPrompt,
        logger: loggerConfig,
      })

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

      const shutdown = () => {
        logger.info('Shutting down...')
        cronScheduler?.stop()
        stopEndpoints()
        process.exit(0)
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error:', error.message)
        process.exit(1)
      }
      throw error
    }
  })

program.parse()
