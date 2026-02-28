import { Bot } from 'grammy'

import { createLogger } from '../logger.ts'

import type { Endpoint, EndpointProfile, InboundMessage, OutboundMessage } from './types.ts'

const TELEGRAM_MESSAGE_LIMIT = 4096

export function resolveTelegramChatIdFromSessionId(sessionId: string): number | undefined {
  if (!sessionId.startsWith('telegram:')) {
    return undefined
  }
  const chatIdStr = sessionId.slice('telegram:'.length)
  if (!/^-?\d+$/.test(chatIdStr)) {
    return undefined
  }
  const chatId = Number(chatIdStr)
  return Number.isSafeInteger(chatId) ? chatId : undefined
}

export interface TelegramEndpointConfig {
  token: string
  allowedUserIds?: number[]
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

export function createTelegramEndpoint(config: TelegramEndpointConfig): Endpoint {
  const bot = new Bot(config.token)
  const logger = createLogger({
    level: config.logLevel,
    filePath: config.logFile,
  })

  // Map sessionId → chatId for outbound routing
  const sessionToChatId = new Map<string, number>()

  const profile: EndpointProfile = {
    kind: 'telegram',
    displayName: 'Telegram chat',
    maxMessageLength: TELEGRAM_MESSAGE_LIMIT,
    responseStyle: 'Be concise and conversational. Use short paragraphs.',
    formatting: 'markdown',
  }

  return {
    profile,

    async send(message: OutboundMessage): Promise<void> {
      const mappedChatId = sessionToChatId.get(message.sessionId)
      const chatId = mappedChatId ?? resolveTelegramChatIdFromSessionId(message.sessionId)
      if (!chatId) {
        logger.error({ sessionId: message.sessionId }, 'No chatId mapped for session')
        throw new Error(`No Telegram chatId available for session: ${message.sessionId}`)
      }
      if (!mappedChatId) {
        sessionToChatId.set(message.sessionId, chatId)
      }

      const chunks = splitMessage(message.text)
      for (const chunk of chunks) {
        await bot.api.sendMessage(chatId, chunk)
      }
    },

    async listen(handler: (message: InboundMessage) => Promise<void>): Promise<() => void> {
      bot.on('message:text', async (ctx) => {
        const chatId = ctx.chat.id
        const userId = ctx.from?.id
        const sessionId = `telegram:${chatId}`

        // Allowlist check: silently drop messages from unauthorized users
        if (config.allowedUserIds && config.allowedUserIds.length > 0) {
          if (!userId || !config.allowedUserIds.includes(userId)) {
            logger.warn({ chatId, userId }, 'Dropping message from unauthorized user')
            return
          }
        }

        // Store the mapping for outbound
        sessionToChatId.set(sessionId, chatId)

        logger.info({ chatId, userId, text: ctx.message.text.slice(0, 100) }, 'Incoming message')

        // Send typing indicator
        await ctx.replyWithChatAction('typing')

        // Keep typing indicator alive during processing
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction('typing').catch(() => {})
        }, 4000)

        // Process message without awaiting to allow concurrent processing
        // This is critical for the "stop" command to work while another request is processing
        handler({
          text: ctx.message.text,
          sessionId,
          endpointKind: 'telegram',
          timestamp: new Date(ctx.message.date * 1000),
          metadata: { userId },
        }).catch((error) => {
          logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Handler error')
        }).finally(() => {
          clearInterval(typingInterval)
        })
      })

      logger.info('Starting Telegram bot (polling mode)...')
      console.log('Bot started, listening for messages... (Ctrl+C to stop)')

      // Start polling (non-blocking)
      bot.start()

      return () => {
        logger.info('Shutting down Telegram bot...')
        bot.stop()
      }
    },
  }
}
