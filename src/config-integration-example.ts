/**
 * Example showing how to integrate the new config system into CLI commands
 * 
 * This demonstrates migrating from:
 *   const model = options.model ?? process.env.DEFAULT_MODEL
 * 
 * To:
 *   const config = await getConfig()
 *   const model = options.model ?? config.llm.defaultModel
 */

import { Command } from 'commander'
import { getConfig } from './config.ts'
import { LLMClient } from './llm/index.ts'

const program = new Command()

program
  .name('jarvis')
  .description('AI assistant CLI using synthetic.new API')
  .version('1.0.0')

// BEFORE: Direct environment variable access
// program
//   .command('chat')
//   .description('Send a message to the LLM')
//   .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
//   .action(async (message, options) => {
//     const model = options.model ?? process.env.DEFAULT_MODEL
//     if (!model) {
//       console.error('Error: Model is required...')
//       process.exit(1)
//     }
//     // ... rest of implementation
//   })

// AFTER: Using the config system
program
  .command('chat [message]')
  .description('Send a message to the LLM')
  .option('-m, --model <model>', 'Model to use (or set DEFAULT_MODEL env var)')
  .option('-t, --temperature <temp>', 'Temperature (0.0-2.0)', '0.7')
  .option('--max-tokens <tokens>', 'Maximum tokens to generate')
  .option('-s, --system <prompt>', 'System prompt')
  .action(async (message, options) => {
    try {
      // Load configuration (merges JSON + env vars + validates)
      const config = await getConfig()
      
      // CLI flag takes precedence, then config, then error
      const model = options.model ?? config.llm.defaultModel
      
      if (!model) {
        console.error('❌ Error: Model is required.')
        console.error('   Either use -m/--model flag or set DEFAULT_MODEL in .config/default.json')
        console.error('   Or set DEFAULT_MODEL environment variable')
        console.error('\n   Run "jarvis list-models" to see available models.')
        process.exit(1)
      }

      // API key from config (loaded from SYNTHETIC_API_KEY env var or JSON)
      const apiKey = config.llm.apiKey
      if (!apiKey) {
        console.error('❌ Error: API key is required.')
        console.error('   Set SYNTHETIC_API_KEY environment variable or add to .config/default.json')
        process.exit(1)
      }

      console.log('🤖 Configuration loaded:')
      console.log(`   Model: ${model}`)
      console.log(`   API Key: ${apiKey.slice(0, 10)}...`)
      console.log(`   Base URL: ${config.llm.baseUrl}`)
      console.log(`   Log Level: ${config.logging.level}`)
      console.log(`   Memory Enabled: ${config.memory.enabled}`)
      console.log(`   Max Parallel Tools: ${config.tools.maxParallel}`)
      console.log()

      // Create client with config values
      const client = new LLMClient({
        apiKey,
        defaultModel: model,
        baseUrl: config.llm.baseUrl,
      })

      // Use the client...
      console.log(`💬 Chat with model: ${model}`)
      console.log(`   Message: ${message || '(no message)'}`)
      console.log()
      console.log('✅ This is a demo - in real usage, this would call the LLM API')
      
    } catch (error) {
      if (error instanceof Error) {
        console.error(`❌ Error: ${error.message}`)
      } else {
        console.error('❌ Unknown error occurred')
      }
      process.exit(1)
    }
  })

// Example command showing all config values
program
  .command('config')
  .description('Show current configuration')
  .action(async () => {
    try {
      const config = await getConfig()
      
      console.log('🔧 Current Configuration\n')
      
      console.log('LLM:')
      console.log(`  Default Model: ${config.llm.defaultModel}`)
      console.log(`  Base URL: ${config.llm.baseUrl}`)
      console.log(`  API Key: ${config.llm.apiKey ? '***set***' : '***NOT SET***'}`)
      
      console.log('\nTelegram:')
      console.log(`  Bot Token: ${config.telegram.botToken ? '***set***' : '***NOT SET***'}`)
      console.log(`  Allowed Users: ${config.telegram.allowedUserIds.join(', ') || '(none)'}`)
      
      console.log('\nMemory:')
      console.log(`  Enabled: ${config.memory.enabled}`)
      console.log(`  Directory: ${config.memory.dir || '(default)'}`)
      console.log(`  Summary Window: ${config.memory.summaryWindowMinutes} minutes`)
      
      console.log('\nLogging:')
      console.log(`  Level: ${config.logging.level}`)
      console.log(`  File: ${config.logging.file || '(none)'}`)
      
      console.log('\nWorkers:')
      console.log(`  Search Pool: ${config.workers.searchPoolSize}`)
      console.log(`  Shell Pool: ${config.workers.shellPoolSize}`)
      
      console.log('\nTools:')
      console.log(`  Max Parallel: ${config.tools.maxParallel}`)
      
    } catch (error) {
      console.error('❌ Failed to load configuration:', error)
      process.exit(1)
    }
  })

// Run the program
program.parse()
