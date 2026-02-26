#!/usr/bin/env node --experimental-strip-types

/**
 * Example demonstrating the new configuration system with c12 + Zod
 * 
 * This shows how to:
 * 1. Load configuration from JSON files
 * 2. Override with environment variables
 * 3. Validate with Zod
 * 4. Use typed config throughout the app
 */

import { getConfig } from './config.ts'

async function main() {
  console.log('🔧 Loading configuration...\n')
  
  const config = await getConfig()
  
  console.log('✅ Configuration loaded successfully!\n')
  
  console.log('📋 Configuration values:')
  console.log('  LLM:')
  console.log(`    Default Model: ${config.llm.defaultModel}`)
  console.log(`    Base URL: ${config.llm.baseUrl}`)
  console.log(`    API Key: ${config.llm.apiKey ? '***set***' : '***NOT SET***'}`)
  
  console.log('\n  Telegram:')
  console.log(`    Bot Token: ${config.telegram.botToken ? '***set***' : '***NOT SET***'}`)
  console.log(`    Allowed User IDs: ${JSON.stringify(config.telegram.allowedUserIds)}`)
  
  console.log('\n  Memory:')
  console.log(`    Enabled: ${config.memory.enabled}`)
  console.log(`    Directory: ${config.memory.dir || '(default)'}`)
  console.log(`    Summary Window: ${config.memory.summaryWindowMinutes} minutes`)
  console.log(`    Auto Summarize: ${config.memory.autoSummarize}`)
  
  console.log('\n  Logging:')
  console.log(`    Level: ${config.logging.level}`)
  console.log(`    File: ${config.logging.file || '(none)'}`)
  
  console.log('\n  Workers:')
  console.log(`    Search Pool Size: ${config.workers.searchPoolSize}`)
  console.log(`    Shell Pool Size: ${config.workers.shellPoolSize}`)
  
  console.log('\n  Tools:')
  console.log(`    Max Parallel: ${config.tools.maxParallel}`)
  
  console.log('\n💡 Try setting environment variables to override defaults:')
  console.log('  DEFAULT_MODEL=hf:other-model node --experimental-strip-types src/config-example.ts')
  console.log('  SYNTHETIC_API_KEY=your-key node --experimental-strip-types src/config-example.ts')
}

main().catch((error) => {
  console.error('❌ Error:', error.message)
  process.exit(1)
})
