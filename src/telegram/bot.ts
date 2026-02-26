import { Bot } from 'grammy'

import { LLMClient, chatWithTools } from '../llm/index.ts'
import { createLogger } from '../logger.ts'

import type { ChatMessage } from '../llm/index.ts'

const TELEGRAM_MESSAGE_LIMIT = 4096
const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant with access to tools: read, glob, grep, edit, write, shell, ask_user, todo_list, web_fetch, sub_agent, and read_file. Prefer specialized tools over shell for file operations.'

export interface TelegramBotConfig {
  token: string
  model: string
  systemPrompt?: string
  logLevel?: string
  logFile?: string
}

/**
 * Split a message into chunks that fit within Telegram's character limit.
 * Tries to split at newline boundaries when possible.
 */
export function splitMessage(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    // Try to find a newline break point within the limit
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) {
      // No newline found, try space
      splitAt = remaining.lastIndexOf(' ', limit)
    }
    if (splitAt <= 0) {
      // No good break point, hard split
      splitAt = limit
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }

  return chunks
}

export function createTelegramBot(config: TelegramBotConfig): Bot {
  const bot = new Bot(config.token)
  const client = new LLMClient({ defaultModel: config.model })
  const logger = createLogger({
    level: config.logLevel,
    filePath: config.logFile,
  })
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT

  // In-memory conversation history per chat
  const conversations = new Map<number, ChatMessage[]>()

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id
    const userText = ctx.message.text

    logger.info({ chatId, userText: userText.slice(0, 100) }, 'Incoming message')

    // Handle /clear command to reset conversation
    if (userText === '/clear') {
      conversations.delete(chatId)
      await ctx.reply('Conversation cleared.')
      return
    }

    // Send typing indicator
    await ctx.replyWithChatAction('typing')

    // Get or initialize conversation history
    let messages = conversations.get(chatId)
    if (!messages) {
      messages = [{ role: 'system', content: systemPrompt }]
      conversations.set(chatId, messages)
    }

    // Add user message
    messages.push({ role: 'user', content: userText })

    try {
      // Keep typing indicator alive during LLM processing
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {})
      }, 4000)

      const response = await chatWithTools(client, messages, {
        model: config.model,
        onToolCall: (observation) => {
          logger.info(
            {
              chatId,
              event: 'tool_call',
              iteration: observation.iteration,
              toolName: observation.toolCall.function.name,
              success: !observation.result.error,
            },
            'Tool call executed'
          )
        },
      })

      clearInterval(typingInterval)

      const content = response.choices[0]?.message?.content
      if (!content) {
        await ctx.reply('(No response from LLM)')
        return
      }

      // Store assistant response in conversation history
      messages.push({ role: 'assistant', content })

      // Split and send response
      const chunks = splitMessage(content)
      for (const chunk of chunks) {
        await ctx.reply(chunk)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error({ chatId, error: errorMessage }, 'Error processing message')
      await ctx.reply(`Sorry, something went wrong: ${errorMessage}`)

      // Remove the failed user message from history so conversation stays clean
      messages.pop()
    }
  })

  return bot
}

export async function startTelegramBot(config: TelegramBotConfig): Promise<void> {
  const bot = createTelegramBot(config)
  const logger = createLogger({
    level: config.logLevel,
    filePath: config.logFile,
  })

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down Telegram bot...')
    bot.stop()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  logger.info({ model: config.model }, 'Starting Telegram bot (polling mode)...')
  console.log('Bot started, listening for messages... (Ctrl+C to stop)')

  await bot.start()
}
