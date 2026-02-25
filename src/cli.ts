#!/usr/bin/env node --experimental-strip-types

import { config } from 'dotenv'
import { Command } from 'commander'

// Load environment variables from .env file
config()
import { LLMClient, chatWithTools } from './llm/index.ts'
import { createLogger } from './logger.ts'
import type { ChatMessage } from './llm/index.ts'

const program = new Command()

program
  .name('jarvis')
  .description('AI assistant CLI using synthetic.new API')
  .version('1.0.0')

program
  .command('chat')
  .description('Send a message to the LLM')
  .argument('<message>', 'Message to send')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-t, --temperature <temp>', 'Temperature (0.0-2.0)', '0.7')
  .option('--max-tokens <tokens>', 'Maximum tokens to generate')
  .option('-s, --system <prompt>', 'System prompt')
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
      
      messages.push({ role: 'user', content: message })

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
          console.error(`Model: ${model}`)
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
  .description('Chat with tool calling enabled (read_file)')
  .argument('<message>', 'Message to send')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-t, --temperature <temp>', 'Temperature (0.0-2.0)', '0.7')
  .option('--max-tokens <tokens>', 'Maximum tokens to generate')
  .option('-s, --system <prompt>', 'System prompt')
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

      const client = new LLMClient({
        defaultModel: model,
      })
      const logger = createLogger({
        level: options.logLevel,
        filePath: options.logFile,
      })

      const messages: ChatMessage[] = []

      if (options.system) {
        messages.push({ role: 'system', content: options.system })
      } else {
        messages.push({
          role: 'system',
          content: 'You are a helpful assistant with access to tools. You can read files using the read_file tool. Use it when the user asks about file contents.',
        })
      }

      messages.push({ role: 'user', content: message })

      console.log('Thinking...\n')

      const response = await chatWithTools(client, messages, {
        model,
        temperature: parseFloat(options.temperature),
        max_tokens: options.maxTokens ? parseInt(options.maxTokens) : undefined,
        onToolCall: ({ iteration, toolCall, result }) => {
          logger.info(
            {
              event: 'tool_call',
              iteration,
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              toolArguments: toolCall.function.arguments,
              success: !result.error,
              toolError: result.error,
            },
            'Tool call executed'
          )
        },
      })

      console.log(response.choices[0]?.message?.content)
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error:', error.message)
        process.exit(1)
      }
      throw error
    }
  })

program.parse()
