#!/usr/bin/env node --experimental-strip-types

/**
 * Integration test for the eviction evaluator.
 * Sends sample evicted messages to the real LLM and prints what it would extract.
 *
 * Usage: node --experimental-strip-types scripts/test-eviction-evaluator.ts
 */

import { config as loadEnv } from 'dotenv'
loadEnv()

import { LLMClient } from '../src/llm/client.ts'
import { getConfig } from '../src/config.ts'

import type { ChatMessage, ChatCompletionResponse } from '../src/llm/types.ts'

/**
 * Extract JSON from LLM response that may contain thinking tags,
 * markdown code fences, or other wrapper text.
 */
function extractJson(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenceMatch) {
    return fenceMatch[1].trim()
  }
  const bracketStart = raw.indexOf('[')
  const bracketEnd = raw.lastIndexOf(']')
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return raw.slice(bracketStart, bracketEnd + 1)
  }
  return raw
}

const EVALUATOR_SYSTEM_PROMPT = `You are a conversation memory evaluator. You receive messages that are being evicted from an assistant's conversation context window.

Your job is to extract any findings worth persisting to long-term memory. Return a JSON array of findings, where each finding has:
- "type": one of "preference" (user preferences, style choices, workflow habits), "fact" (important facts, decisions, project context), or "conversation_summary" (brief summary if the conversation had meaningful substance)
- "content": the finding as a concise sentence
- "tags": array of 1-3 relevant keywords

Return an empty array [] if nothing is worth saving. Be selective — only extract genuinely useful information.

Respond ONLY with a valid JSON array, no other text.`

// Sample evicted messages simulating a real conversation
const sampleEvictedMessages: ChatMessage[] = [
  {
    role: 'user',
    content: 'Can you always use TypeScript when writing code for me? I prefer strict typing.',
  },
  {
    role: 'assistant',
    content: 'Absolutely! I\'ll always use TypeScript with strict typing for your code. Got it.',
  },
  {
    role: 'user',
    content: 'I\'m working on a project called Jarvis. It\'s a Node.js AI assistant that uses the synthetic.new API. We decided to use SQLite for memory storage instead of Redis because it\'s simpler to deploy.',
  },
  {
    role: 'assistant',
    content: 'That makes sense — SQLite is a great fit for a single-process assistant. It avoids the operational overhead of Redis while still giving you durable, queryable storage. I\'ll keep that architecture decision in mind.',
  },
  {
    role: 'user',
    content: 'Read the file src/tools/shell.ts and tell me what safeguards it has.',
  },
  {
    role: 'tool',
    content: '(tool output from reading shell.ts — blocked commands list, timeout enforcement, etc.)',
  },
  {
    role: 'assistant',
    content: 'The shell tool has several safeguards: a blocklist of dangerous commands (rm -rf /, etc.), a configurable timeout (default 30s), max buffer limits, and it runs in a sandboxed shell pool with concurrency limiting.',
  },
  {
    role: 'user',
    content: 'Great. By the way, my timezone is US/Pacific and I prefer 24-hour time format.',
  },
  {
    role: 'assistant',
    content: 'Noted! I\'ll use US/Pacific timezone and 24-hour format when displaying times.',
  },
]

async function main(): Promise<void> {
  const config = await getConfig()
  const model = config.llm.defaultModel

  if (!model) {
    console.error('Error: No DEFAULT_MODEL configured. Set it in .env or jarvis.config.ts')
    process.exit(1)
  }

  const client = new LLMClient({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    defaultModel: model,
    provider: config.llm.provider,
  })

  const transcript = sampleEvictedMessages
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n')

  console.log('=== Eviction Evaluator Integration Test ===\n')
  console.log(`Model: ${model}`)
  console.log(`Evicted messages: ${sampleEvictedMessages.length}`)
  console.log(`Transcript length: ${transcript.length} chars\n`)
  console.log('--- Transcript sent to LLM ---')
  console.log(transcript)
  console.log('\n--- Calling LLM... ---\n')

  let response: ChatCompletionResponse
  try {
    response = await client.chat(
      [
        { role: 'system', content: EVALUATOR_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      { model, temperature: 0.2, max_tokens: 500 }
    )
  } catch (err) {
    console.error('LLM call failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const raw = response.choices[0]?.message?.content?.trim()
  console.log('--- Raw LLM response ---')
  console.log(raw)
  console.log()

  if (response.usage) {
    console.log('--- Token usage ---')
    console.log(`  Prompt tokens:     ${response.usage.prompt_tokens}`)
    console.log(`  Completion tokens: ${response.usage.completion_tokens}`)
    console.log(`  Total tokens:      ${response.usage.total_tokens}`)
    console.log()
  }

  if (!raw) {
    console.log('ERROR: Empty response from LLM')
    process.exit(1)
  }

  // Strip provider-specific wrappers (e.g. MiniMax <think> tags)
  const visibleContent = client.toUserVisibleContent(raw)
  console.log('--- After stripping think tags ---')
  console.log(visibleContent)
  console.log()

  let findings: Array<{ type: string, content: string, tags: string[] }>
  try {
    const jsonStr = extractJson(visibleContent)
    console.log('--- Extracted JSON ---')
    console.log(jsonStr)
    console.log()
    findings = JSON.parse(jsonStr)
  } catch {
    console.log('ERROR: Failed to parse JSON from LLM response')
    console.log('This means the prompt needs adjustment — the LLM returned non-JSON.')
    process.exit(1)
  }

  if (!Array.isArray(findings)) {
    console.log('ERROR: LLM returned non-array JSON:', typeof findings)
    process.exit(1)
  }

  console.log(`--- Parsed findings (${findings.length}) ---`)
  for (const finding of findings) {
    console.log(`  [${finding.type}] ${finding.content}`)
    console.log(`    tags: ${finding.tags?.join(', ') || '(none)'}`)
  }

  console.log('\n=== Test complete ===')
}

main()
