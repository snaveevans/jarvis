import { estimateTokenCount } from '../memory/helpers.ts'

import type { Tool, ToolResult, ToolExecutionContext } from './types.ts'
import type { EventStore, ToolCallEvent, LLMCallEvent, ErrorEvent } from '../telemetry/event-store.ts'
import type { SessionStore } from '../sessions/store.ts'
import type { MemoryService } from '../memory/index.ts'
import type { JarvisConfig } from '../config.ts'

const SUBJECTS = ['session', 'tools', 'llm', 'memory', 'config', 'metrics', 'errors', 'recent'] as const
type Subject = (typeof SUBJECTS)[number]

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function sinceStr(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? '***set***' : '(not set)'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

export interface IntrospectToolDeps {
  eventStore?: EventStore
  sessionStore?: SessionStore
  memoryService?: MemoryService
  config?: JarvisConfig
  processStartMs?: number
}

export function createIntrospectTool(deps: IntrospectToolDeps = {}): Tool {
  const processStartMs = deps.processStartMs ?? Date.now()

  return {
    name: 'introspect',
    description: [
      'Inspect Jarvis runtime state for debugging and self-diagnosis.',
      'Use subject="session" for context window usage,',
      '"tools" for recent tool call history and errors,',
      '"llm" for API call history and token usage,',
      '"memory" for memory database stats,',
      '"config" for current configuration,',
      '"metrics" for performance aggregates,',
      '"errors" for recent errors,',
      '"recent" for a combined timeline of recent events.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          enum: SUBJECTS,
          description: 'What aspect of Jarvis to inspect.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session ID filter (default: current session).',
        },
        limit: {
          type: 'number',
          description: 'Max number of events to return (default: 20).',
        },
      },
      required: ['subject'],
    },

    async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
      const subject = args.subject as Subject | undefined
      const sessionId = (args.sessionId as string | undefined) ?? context?.sessionId
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20

      if (!subject || !SUBJECTS.includes(subject)) {
        return {
          content: '',
          error: `Invalid subject. Choose one of: ${SUBJECTS.join(', ')}`,
        }
      }

      try {
        const content = await resolveSubject(subject, sessionId, limit, deps, processStartMs)
        return { content }
      } catch (err) {
        return {
          content: '',
          error: `Introspect failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }
}

async function resolveSubject(
  subject: Subject,
  sessionId: string | undefined,
  limit: number,
  deps: IntrospectToolDeps,
  processStartMs: number
): Promise<string> {
  const { eventStore, sessionStore, memoryService, config } = deps
  const uptimeSecs = Math.floor((Date.now() - processStartMs) / 1000)
  const uptimeStr = uptimeSecs < 60
    ? `${uptimeSecs}s`
    : uptimeSecs < 3600
      ? `${Math.floor(uptimeSecs / 60)}m ${uptimeSecs % 60}s`
      : `${Math.floor(uptimeSecs / 3600)}h ${Math.floor((uptimeSecs % 3600) / 60)}m`

  switch (subject) {
    case 'session': {
      const lines = [`## Session State (uptime: ${uptimeStr})`]
      if (!sessionId) {
        lines.push('No session ID available.')
        return lines.join('\n')
      }
      const session = sessionStore?.get(sessionId)
      if (!session) {
        lines.push(`Session "${sessionId}" not found.`)
        return lines.join('\n')
      }
      const tokens = session.messages.reduce((sum, m) => sum + estimateTokenCount(m.content), 0)
      const byRole: Record<string, number> = {}
      for (const m of session.messages) {
        byRole[m.role] = (byRole[m.role] ?? 0) + 1
      }
      const roleBreakdown = Object.entries(byRole)
        .map(([r, n]) => `${r}:${n}`)
        .join(', ')
      lines.push(`Session ID: ${sessionId}`)
      lines.push(`Messages: ${session.messages.length} (${roleBreakdown})`)
      lines.push(`Estimated tokens: ${tokens.toLocaleString()}`)
      lines.push(`Created: ${session.createdAt.toISOString()}`)
      const sessionEvents = eventStore?.query({ type: 'session', sessionId }) ?? []
      const evictions = sessionEvents.filter(e => e.type === 'session' && (e as { action: string }).action === 'evicted')
      if (evictions.length > 0) {
        lines.push(`Context evictions: ${evictions.length}`)
      }
      return lines.join('\n')
    }

    case 'tools': {
      const lines = ['## Recent Tool Calls']
      if (!eventStore) {
        lines.push('Event store not available.')
        return lines.join('\n')
      }
      const toolEvents = eventStore.query({ type: 'tool_call', sessionId, limit }) as ToolCallEvent[]
      if (toolEvents.length === 0) {
        lines.push('No tool calls recorded yet.')
        return lines.join('\n')
      }
      const errors = toolEvents.filter(e => !e.success)
      lines.push(`Total calls shown: ${toolEvents.length}, Errors: ${errors.length}`)
      lines.push('')
      for (const e of toolEvents.slice(-limit)) {
        const status = e.success ? '✓' : '✗'
        const err = e.errorMessage ? ` — ${e.errorMessage.slice(0, 80)}` : ''
        lines.push(`${status} [${sinceStr(e.timestampMs)}] ${e.toolName}(${e.argsSummary.slice(0, 60)}) ${formatMs(e.durationMs)}${err}`)
      }
      return lines.join('\n')
    }

    case 'llm': {
      const lines = ['## LLM API Call History']
      if (!eventStore) {
        lines.push('Event store not available.')
        return lines.join('\n')
      }
      const llmEvents = eventStore.query({ type: 'llm_call', sessionId, limit }) as LLMCallEvent[]
      if (llmEvents.length === 0) {
        lines.push('No LLM calls recorded yet.')
        return lines.join('\n')
      }
      let totalPrompt = 0, totalCompletion = 0
      for (const e of llmEvents) {
        totalPrompt += e.promptTokens
        totalCompletion += e.completionTokens
      }
      lines.push(`Calls: ${llmEvents.length}, Total tokens: ${(totalPrompt + totalCompletion).toLocaleString()} (prompt: ${totalPrompt.toLocaleString()}, completion: ${totalCompletion.toLocaleString()})`)
      lines.push('')
      for (const e of llmEvents.slice(-limit)) {
        lines.push(`[${sinceStr(e.timestampMs)}] ${e.model} — ${e.totalTokens.toLocaleString()} tokens (${e.promptTokens}p + ${e.completionTokens}c) in ${formatMs(e.durationMs)}`)
      }
      return lines.join('\n')
    }

    case 'memory': {
      const lines = ['## Memory Database']
      if (!memoryService) {
        lines.push('Memory service not available.')
        return lines.join('\n')
      }
      const stats = await memoryService.getStats()
      lines.push(`DB path: ${stats.dbPath}`)
      lines.push(`DB size: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`)
      lines.push(`Total memories: ${stats.totalCount} (~${stats.totalTokenCount.toLocaleString()} tokens)`)
      lines.push('By type:')
      for (const [type, count] of Object.entries(stats.byType)) {
        lines.push(`  ${type}: ${count}`)
      }
      return lines.join('\n')
    }

    case 'config': {
      const lines = ['## Current Configuration']
      if (!config) {
        lines.push('Config not available.')
        return lines.join('\n')
      }
      lines.push(`Provider: ${config.llm.provider}`)
      lines.push(`Default model: ${config.llm.defaultModel}`)
      lines.push(`Base URL: ${config.llm.baseUrl}`)
      lines.push(`API key: ${maskApiKey(config.llm.apiKey)}`)
      lines.push(`Log level: ${config.logging.level}`)
      lines.push(`Memory enabled: ${config.memory.enabled}`)
      lines.push('Tool limits:')
      lines.push(`  maxIterations=${config.tools.maxIterations}, maxParallel=${config.tools.maxParallel}`)
      lines.push(`  maxOutputLines=${config.tools.maxOutputLines}, timeoutMs=${config.tools.timeoutMs}`)
      lines.push(`  maxGlobResults=${config.tools.maxGlobResults}, maxGrepMatches=${config.tools.maxGrepMatches}`)
      return lines.join('\n')
    }

    case 'metrics': {
      const lines = ['## Performance Metrics']
      if (!eventStore) {
        lines.push('Event store not available.')
        return lines.join('\n')
      }
      const storeStats = eventStore.stats()
      lines.push(`Event buffer: ${storeStats.bufferedCount}/${storeStats.maxBufferSize} (${storeStats.totalRecorded} total recorded)`)

      const allTools = eventStore.query({ type: 'tool_call' }) as ToolCallEvent[]
      if (allTools.length > 0) {
        const byTool: Record<string, { count: number, errors: number, totalMs: number }> = {}
        for (const e of allTools) {
          if (!byTool[e.toolName]) byTool[e.toolName] = { count: 0, errors: 0, totalMs: 0 }
          byTool[e.toolName].count++
          if (!e.success) byTool[e.toolName].errors++
          byTool[e.toolName].totalMs += e.durationMs
        }
        lines.push('\nTool call stats:')
        const sorted = Object.entries(byTool).sort((a, b) => b[1].count - a[1].count)
        for (const [name, s] of sorted) {
          const avgMs = Math.round(s.totalMs / s.count)
          const errRate = s.errors > 0 ? ` (${s.errors} errors)` : ''
          lines.push(`  ${name}: ${s.count} calls, avg ${formatMs(avgMs)}${errRate}`)
        }
      }

      const allLLM = eventStore.query({ type: 'llm_call' }) as LLMCallEvent[]
      if (allLLM.length > 0) {
        const totalTokens = allLLM.reduce((s, e) => s + e.totalTokens, 0)
        const avgLatency = Math.round(allLLM.reduce((s, e) => s + e.durationMs, 0) / allLLM.length)
        lines.push(`\nLLM: ${allLLM.length} calls, ${totalTokens.toLocaleString()} total tokens, avg latency ${formatMs(avgLatency)}`)
      }

      const allErrors = eventStore.query({ type: 'error' })
      if (allErrors.length > 0) {
        lines.push(`\nErrors recorded: ${allErrors.length}`)
      }

      return lines.join('\n')
    }

    case 'errors': {
      const lines = ['## Recent Errors']
      if (!eventStore) {
        lines.push('Event store not available.')
        return lines.join('\n')
      }
      const errors = eventStore.query({ type: 'error', sessionId, limit }) as ErrorEvent[]
      if (errors.length === 0) {
        lines.push('No errors recorded.')
        return lines.join('\n')
      }
      for (const e of errors.slice(-limit)) {
        const code = e.code ? ` [${e.code}]` : ''
        const status = e.statusCode ? ` HTTP ${e.statusCode}` : ''
        lines.push(`[${sinceStr(e.timestampMs)}] ${e.category}${code}${status}: ${e.message}`)
      }
      return lines.join('\n')
    }

    case 'recent': {
      const lines = ['## Recent Events (Timeline)']
      if (!eventStore) {
        lines.push('Event store not available.')
        return lines.join('\n')
      }
      const events = eventStore.query({ sessionId, limit })
      if (events.length === 0) {
        lines.push('No events recorded yet.')
        return lines.join('\n')
      }
      for (const e of events) {
        switch (e.type) {
          case 'tool_call': {
            const tc = e as ToolCallEvent
            const status = tc.success ? '✓' : '✗'
            lines.push(`${status} tool:${tc.toolName} ${formatMs(tc.durationMs)} [${sinceStr(e.timestampMs)}]`)
            break
          }
          case 'llm_call': {
            const lc = e as LLMCallEvent
            lines.push(`  llm:${lc.model} ${lc.totalTokens}tok ${formatMs(lc.durationMs)} [${sinceStr(e.timestampMs)}]`)
            break
          }
          case 'error': {
            const er = e as ErrorEvent
            lines.push(`✗ error:${er.category} ${er.message.slice(0, 80)} [${sinceStr(e.timestampMs)}]`)
            break
          }
          case 'session': {
            const se = e as { action: string }
            lines.push(`  session:${se.action} [${sinceStr(e.timestampMs)}]`)
            break
          }
        }
      }
      return lines.join('\n')
    }
  }
}
