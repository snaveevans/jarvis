import type { Tool, ToolResult } from './types.ts'
import type { LLMClient } from '../llm/client.ts'
import type { MemoryService } from '../memory/index.ts'
import type { SessionStore } from '../sessions/store.ts'
import type { ToolExecutionContext } from './types.ts'

interface HealthStatus {
  status: 'ok' | 'degraded' | 'error'
  detail?: string
  latencyMs?: number
}

export interface HealthCheckToolDeps {
  client?: LLMClient
  memoryService?: MemoryService
  sessionStore?: SessionStore
  processStartMs?: number
}

function uptimeStr(startMs: number): string {
  const secs = Math.floor((Date.now() - startMs) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

export function createHealthCheckTool(deps: HealthCheckToolDeps = {}): Tool {
  const processStartMs = deps.processStartMs ?? Date.now()

  return {
    name: 'health_check',
    description: [
      'Run a diagnostic check on Jarvis subsystems.',
      'Reports health of: LLM API, memory database, session store.',
      'Use when the LLM feels unresponsive or to verify all systems before a complex task.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        checkLLM: {
          type: 'boolean',
          description: 'Whether to ping the LLM API (default: true). Uses /models and falls back to a tiny completion probe if needed.',
        },
      },
      required: [],
    },

    async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
      const checkLLM = args.checkLLM !== false
      const results: string[] = [`## Health Check (uptime: ${uptimeStr(processStartMs)})`]

      // LLM check
      const llmStatus: HealthStatus = await (async () => {
        if (!deps.client) return { status: 'error', detail: 'LLM client not wired' }
        if (!checkLLM) return { status: 'ok', detail: 'skipped' }
        const start = Date.now()
        const probeMessages = [{ role: 'user' as const, content: 'Reply with OK.' }]
        try {
          const models = await deps.client.listModels()
          const latencyMs = Date.now() - start
          return { status: 'ok', detail: `${models.length} models available`, latencyMs }
        } catch (modelsErr) {
          try {
            const completion = await deps.client.chat(probeMessages, {
              temperature: 0,
              max_tokens: 8,
            })
            const latencyMs = Date.now() - start
            const reply = completion.choices[0]?.message?.content?.trim() || '(empty)'
            const modelsErrorDetail = modelsErr instanceof Error ? modelsErr.message : String(modelsErr)
            return {
              status: 'ok',
              detail: `completion probe succeeded after /models failed (${modelsErrorDetail}); reply: ${reply}`,
              latencyMs,
            }
          } catch (probeErr) {
            const latencyMs = Date.now() - start
            const modelsErrorDetail = modelsErr instanceof Error ? modelsErr.message : String(modelsErr)
            const probeErrorDetail = probeErr instanceof Error ? probeErr.message : String(probeErr)
            return {
              status: 'error',
              detail: `/models failed (${modelsErrorDetail}); completion probe failed (${probeErrorDetail})`,
              latencyMs,
            }
          }
        }
      })()
      const llmLatency = llmStatus.latencyMs != null ? ` (${llmStatus.latencyMs}ms)` : ''
      results.push(`LLM API: ${llmStatus.status}${llmLatency}${llmStatus.detail ? ' — ' + llmStatus.detail : ''}`)

      // Memory check
      const memStatus: HealthStatus = await (async () => {
        if (!deps.memoryService) return { status: 'degraded', detail: 'not configured' }
        const start = Date.now()
        try {
          const stats = await deps.memoryService.getStats()
          const latencyMs = Date.now() - start
          return {
            status: 'ok',
            detail: `${stats.totalCount} memories, ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`,
            latencyMs,
          }
        } catch (err) {
          return {
            status: 'error',
            detail: err instanceof Error ? err.message : String(err),
          }
        }
      })()
      const memLatency = memStatus.latencyMs != null ? ` (${memStatus.latencyMs}ms)` : ''
      results.push(`Memory DB: ${memStatus.status}${memLatency}${memStatus.detail ? ' — ' + memStatus.detail : ''}`)

      // Session check
      const sessionStatus: HealthStatus = (() => {
        if (!deps.sessionStore) return { status: 'degraded', detail: 'not wired' }
        const sessionId = context?.sessionId
        const session = sessionId ? deps.sessionStore.get(sessionId) : undefined
        const detail = session
          ? `session has ${session.messages.length} messages`
          : 'session store available'
        return { status: 'ok', detail }
      })()
      results.push(`Session store: ${sessionStatus.status}${sessionStatus.detail ? ' — ' + sessionStatus.detail : ''}`)

      // Overall
      const allStatuses = [llmStatus, memStatus, sessionStatus].map(s => s.status)
      const overallStatus = allStatuses.includes('error') ? 'error'
        : allStatuses.includes('degraded') ? 'degraded'
          : 'ok'
      results.splice(1, 0, `Overall: ${overallStatus}\n`)

      return { content: results.join('\n') }
    },
  }
}
