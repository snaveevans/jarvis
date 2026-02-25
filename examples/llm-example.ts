import { LLMClient } from '../src/llm/index.ts'

async function main() {
  try {
    const client = new LLMClient()
    
    console.log('Listing models...')
    const models = await client.listModels()
    console.log(`Found ${models.length} models`)
    console.log('First 3 models:', models.slice(0, 3).map(m => m.id))
    
    console.log('\nSending chat message...')
    const response = await client.chat([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Say "Hello from Jarvis!" and nothing else.' }
    ], {
      max_tokens: 50
    })
    
    console.log('Response:', response.choices[0]?.message?.content)
  } catch (error) {
    console.error('Error:', error)
  }
}

main()
