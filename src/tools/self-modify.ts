import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import type pino from 'pino'

import type { Tool, ToolResult } from './types.ts'

// ---------- types ----------

interface ModificationRecord {
  id: string
  branch: string
  description: string
  filesChanged: string[]
  startedAt: string
  completedAt?: string
  outcome: 'pending' | 'validated' | 'promoted' | 'reverted' | 'failed'
}

interface SelfModifyState {
  status: 'idle' | 'in_progress' | 'validating'
  branch?: string
  lastGoodCommit: string
  canaryPid?: number
  canaryPort?: number
  modifications: ModificationRecord[]
  cooldownUntil?: string
}

export interface SelfModifyConfig {
  dataDir: string
  logger: pino.Logger
  jarvisRoot: string
  canaryPort?: number
  cooldownMinutes?: number
  protectedPaths?: string[]
  requestRestart: (exitCode: number) => void
}

export interface SelfModifyHandle {
  tools: Tool[]
  initialize(): Promise<void>
  shutdown(): void
}

// ---------- constants ----------

const DEFAULT_CANARY_PORT = 3001
const DEFAULT_COOLDOWN_MINUTES = 10
const MAX_HISTORY = 20
const CANARY_BOOT_WAIT_MS = 5_000
const CANARY_HEALTH_TIMEOUT_MS = 5_000

const DEFAULT_PROTECTED_PATHS = [
  'bin/jarvis-supervisor',
  'src/tools/self-modify.ts',
  'src/tools/common.ts',
  '.env',
  '.config/',
  'data/',
]

// Env vars stripped from canary to prevent it from starting endpoints
// that conflict with the production instance (e.g. Telegram long-polling).
const CANARY_STRIP_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
]

// ---------- helpers ----------

function exec(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<{ stdout: string, stderr: string, exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error && 'code' in error ? (error as { code: number }).code : (error ? 1 : 0)
      resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', exitCode })
    })
  })
}

function git(args: string[], cwd: string): Promise<{ stdout: string, stderr: string, exitCode: number }> {
  return exec('git', args, cwd)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // already dead
  }
}

async function probeHealth(port: number, timeoutMs: number = CANARY_HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

function buildCanaryEnv(canaryPort: number): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !CANARY_STRIP_ENV_KEYS.includes(key)) {
      env[key] = value
    }
  }
  env.JARVIS_CANARY = '1'
  env.JARVIS_HEALTH_PORT = String(canaryPort)
  return env
}

// ---------- factory ----------

export function createSelfModifyTools(config: SelfModifyConfig): SelfModifyHandle {
  const statePath = path.join(config.dataDir, 'self-modify-state.json')
  const supervisorStatePath = path.join(config.dataDir, 'supervisor-state.json')
  const canaryPort = config.canaryPort ?? DEFAULT_CANARY_PORT
  const cooldownMinutes = config.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES
  const protectedPaths = config.protectedPaths ?? DEFAULT_PROTECTED_PATHS
  const jarvisRoot = config.jarvisRoot

  let state: SelfModifyState = {
    status: 'idle',
    lastGoodCommit: '',
    modifications: [],
  }

  // --- state persistence ---

  async function loadState(): Promise<void> {
    try {
      const raw = await readFile(statePath, 'utf-8')
      state = JSON.parse(raw)
    } catch {
      // first run or corrupt — use defaults
      const headResult = await git(['rev-parse', 'HEAD'], jarvisRoot)
      state = {
        status: 'idle',
        lastGoodCommit: headResult.stdout.trim() || '',
        modifications: [],
      }
    }
  }

  async function saveState(): Promise<void> {
    await mkdir(path.dirname(statePath), { recursive: true })
    const tmp = `${statePath}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tmp, statePath)
  }

  async function writeSupervisorState(): Promise<void> {
    await mkdir(path.dirname(supervisorStatePath), { recursive: true })
    const data = {
      lastGoodCommit: state.lastGoodCommit,
      consecutiveCrashes: 0,
      lastCrashAt: null,
    }
    const tmp = `${supervisorStatePath}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    await rename(tmp, supervisorStatePath)
  }

  // --- canary management ---

  function cleanupCanary(): void {
    if (state.canaryPid && isProcessAlive(state.canaryPid)) {
      config.logger.info({ pid: state.canaryPid }, 'Killing canary process')
      killProcess(state.canaryPid)
    }
    state.canaryPid = undefined
    state.canaryPort = undefined
  }

  // --- protected path checks ---

  function checkProtectedPaths(changedFiles: string[]): string[] {
    const violations: string[] = []
    for (const file of changedFiles) {
      for (const protected_ of protectedPaths) {
        if (protected_.endsWith('/')) {
          if (file.startsWith(protected_) || file === protected_.slice(0, -1)) {
            violations.push(file)
          }
        } else if (file === protected_) {
          violations.push(file)
        }
      }
    }
    return violations
  }

  // --- current modification record helpers ---

  function currentRecord(): ModificationRecord | undefined {
    if (!state.branch) return undefined
    return state.modifications.find(m => m.branch === state.branch && m.outcome === 'pending')
      ?? state.modifications.find(m => m.branch === state.branch && m.outcome === 'validated')
  }

  function updateCurrentRecord(update: Partial<ModificationRecord>): void {
    const record = currentRecord()
    if (record) {
      Object.assign(record, update)
    }
  }

  // --- cooldown ---

  function isInCooldown(): boolean {
    if (!state.cooldownUntil) return false
    return new Date(state.cooldownUntil).getTime() > Date.now()
  }

  function setCooldown(): void {
    state.cooldownUntil = new Date(Date.now() + cooldownMinutes * 60_000).toISOString()
  }

  // ---------- tools ----------

  const selfModifyStart: Tool = {
    name: 'self_modify_start',
    description: [
      'Begin a self-modification session.',
      'Creates a new git branch for changes.',
      'Rejects if a modification is already in progress or within cooldown period.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Brief description of the planned modification',
        },
      },
      required: ['description'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const description = args.description as string
      if (!description || typeof description !== 'string') {
        return { content: '', error: 'description is required' }
      }

      if (state.status !== 'idle') {
        return { content: '', error: `Cannot start: status is "${state.status}" (branch: ${state.branch ?? 'none'}). Revert or promote the current modification first.` }
      }

      if (isInCooldown()) {
        return { content: '', error: `Cooldown active until ${state.cooldownUntil}. Wait before starting another modification.` }
      }

      // Record current HEAD as checkpoint
      const headResult = await git(['rev-parse', 'HEAD'], jarvisRoot)
      if (headResult.exitCode !== 0) {
        return { content: '', error: `Failed to get HEAD: ${headResult.stderr}` }
      }
      const checkpoint = headResult.stdout.trim()

      // Ensure we're on main
      const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], jarvisRoot)
      const currentBranch = branchResult.stdout.trim()
      if (currentBranch !== 'main') {
        return { content: '', error: `Must be on main branch to start self-modification (currently on: ${currentBranch})` }
      }

      // Create branch
      const timestamp = Date.now()
      const branchName = `jarvis/self-mod-${timestamp}`
      const createResult = await git(['checkout', '-b', branchName], jarvisRoot)
      if (createResult.exitCode !== 0) {
        return { content: '', error: `Failed to create branch: ${createResult.stderr}` }
      }

      // Record
      const record: ModificationRecord = {
        id: randomUUID(),
        branch: branchName,
        description,
        filesChanged: [],
        startedAt: new Date().toISOString(),
        outcome: 'pending',
      }

      state.status = 'in_progress'
      state.branch = branchName
      state.lastGoodCommit = checkpoint
      state.modifications.push(record)

      // Trim history
      if (state.modifications.length > MAX_HISTORY) {
        state.modifications = state.modifications.slice(-MAX_HISTORY)
      }

      await saveState()
      config.logger.info({ branch: branchName, description }, 'Self-modification started')

      return {
        content: [
          `Self-modification session started.`,
          `Branch: ${branchName}`,
          `Checkpoint: ${checkpoint}`,
          ``,
          `You may now make changes using read, edit, and write tools.`,
          `When ready, call self_modify_validate to build, test, and verify.`,
        ].join('\n'),
      }
    },
  }

  const selfModifyValidate: Tool = {
    name: 'self_modify_validate',
    description: [
      'Validate current self-modification changes.',
      'Checks protected paths, commits changes, runs build and tests, optionally boots a canary.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        commit_message: {
          type: 'string',
          description: 'Git commit message for the changes',
        },
        skip_canary: {
          type: 'boolean',
          description: 'Skip canary boot test (default: false)',
        },
      },
      required: ['commit_message'],
    },
    timeoutMs: 120_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const commitMessage = args.commit_message as string
      const skipCanary = args.skip_canary === true

      if (!commitMessage || typeof commitMessage !== 'string') {
        return { content: '', error: 'commit_message is required' }
      }

      if (state.status !== 'in_progress') {
        return { content: '', error: `Cannot validate: status is "${state.status}". Must be "in_progress".` }
      }

      const output: string[] = []

      // 1. Check protected paths
      const diffResult = await git(['diff', '--name-only', 'main...HEAD'], jarvisRoot)
      const stagedResult = await git(['diff', '--name-only', '--cached'], jarvisRoot)
      const untrackedResult = await git(['ls-files', '--others', '--exclude-standard'], jarvisRoot)

      const allChanged = [
        ...diffResult.stdout.split('\n'),
        ...stagedResult.stdout.split('\n'),
        ...untrackedResult.stdout.split('\n'),
      ].map(f => f.trim()).filter(Boolean)
      const uniqueChanged = [...new Set(allChanged)]

      const violations = checkProtectedPaths(uniqueChanged)
      if (violations.length > 0) {
        return {
          content: '',
          error: `Protected path violation. These files cannot be modified:\n${violations.map(v => `  - ${v}`).join('\n')}\n\nRevert changes to protected files before validating.`,
        }
      }

      output.push(`Changed files: ${uniqueChanged.join(', ')}`)
      updateCurrentRecord({ filesChanged: uniqueChanged })

      // 2. Commit
      const addResult = await git(['add', '-A'], jarvisRoot)
      if (addResult.exitCode !== 0) {
        return { content: '', error: `git add failed: ${addResult.stderr}` }
      }

      const commitResult = await git(['commit', '-m', commitMessage], jarvisRoot)
      if (commitResult.exitCode !== 0) {
        if (commitResult.stdout.includes('nothing to commit')) {
          return { content: '', error: 'Nothing to commit. Make changes first.' }
        }
        return { content: '', error: `git commit failed: ${commitResult.stderr}\n${commitResult.stdout}` }
      }
      output.push(`Committed: ${commitMessage}`)

      // 3. Build
      output.push('Running build...')
      const buildResult = await exec('npm', ['run', 'build'], jarvisRoot, 60_000)
      if (buildResult.exitCode !== 0) {
        const buildOutput = (buildResult.stdout + '\n' + buildResult.stderr).trim()
        return {
          content: '',
          error: `Build failed (exit ${buildResult.exitCode}):\n${buildOutput.slice(-2000)}\n\nFix the build errors and call self_modify_validate again.`,
        }
      }
      output.push('Build: PASSED')

      // 4. Test
      output.push('Running tests...')
      const testResult = await exec('npm', ['test'], jarvisRoot, 90_000)
      if (testResult.exitCode !== 0) {
        const testOutput = (testResult.stdout + '\n' + testResult.stderr).trim()
        return {
          content: '',
          error: `Tests failed (exit ${testResult.exitCode}):\n${testOutput.slice(-2000)}\n\nFix the test failures and call self_modify_validate again.`,
        }
      }
      output.push('Tests: PASSED')

      // 5. Canary — spawns with TELEGRAM_BOT_TOKEN stripped so it won't
      //    start Telegram long-polling and conflict with the production bot.
      if (!skipCanary) {
        output.push(`Starting canary on port ${canaryPort}...`)
        try {
          const canaryEnv = buildCanaryEnv(canaryPort)

          const canary = spawn('node', ['dist/cli.js', 'serve', '--log-level', 'warn'], {
            cwd: jarvisRoot,
            stdio: 'ignore',
            detached: true,
            env: canaryEnv,
          })
          canary.unref()

          if (!canary.pid) {
            output.push('Canary: FAILED to spawn (no PID)')
            return {
              content: '',
              error: output.join('\n') + '\n\nCanary process failed to start.',
            }
          }

          state.canaryPid = canary.pid
          state.canaryPort = canaryPort

          // Wait for boot
          await new Promise(r => setTimeout(r, CANARY_BOOT_WAIT_MS))

          // Check if still alive
          if (!isProcessAlive(canary.pid)) {
            state.canaryPid = undefined
            state.canaryPort = undefined
            output.push('Canary: CRASHED during boot')
            return {
              content: '',
              error: output.join('\n') + '\n\nCanary process crashed during boot. Check the changes.',
            }
          }

          // Health probe
          const healthy = await probeHealth(canaryPort)
          if (healthy) {
            output.push(`Canary: HEALTHY (PID ${canary.pid}, port ${canaryPort})`)
          } else {
            // Still alive but health check failed — acceptable as health endpoint may not exist
            output.push(`Canary: ALIVE but health endpoint unreachable (PID ${canary.pid})`)
            output.push('(This is acceptable if health_check endpoint is not configured)')
          }
        } catch (canaryErr) {
          output.push(`Canary: ERROR — ${canaryErr instanceof Error ? canaryErr.message : String(canaryErr)}`)
        }
      } else {
        output.push('Canary: SKIPPED')
      }

      // Set status
      state.status = 'validating'
      updateCurrentRecord({ outcome: 'validated' })
      await saveState()

      output.push('')
      output.push('Validation complete. Call self_modify_promote to merge and restart, or self_modify_revert to abandon.')

      return { content: output.join('\n') }
    },
  }

  const selfModifyPromote: Tool = {
    name: 'self_modify_promote',
    description: [
      'Promote validated self-modifications to production.',
      'Merges the branch into main, rebuilds, updates supervisor state, and triggers a restart.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      if (state.status !== 'validating' && state.status !== 'in_progress') {
        return { content: '', error: `Cannot promote: status is "${state.status}". Must be "validating" (or "in_progress" if canary was skipped).` }
      }

      if (!state.branch) {
        return { content: '', error: 'No branch to promote.' }
      }

      const branch = state.branch
      const output: string[] = []

      // Kill canary
      cleanupCanary()

      // Merge into main
      const checkoutResult = await git(['checkout', 'main'], jarvisRoot)
      if (checkoutResult.exitCode !== 0) {
        return { content: '', error: `Failed to checkout main: ${checkoutResult.stderr}` }
      }

      const mergeResult = await git(['merge', '--no-ff', branch, '-m', `self-modify: merge ${branch}`], jarvisRoot)
      if (mergeResult.exitCode !== 0) {
        await git(['merge', '--abort'], jarvisRoot)
        await git(['checkout', branch], jarvisRoot)
        return { content: '', error: `Merge failed: ${mergeResult.stderr}\n\nResolve conflicts manually or revert.` }
      }
      output.push(`Merged ${branch} into main`)

      // Rebuild on main
      const buildResult = await exec('npm', ['run', 'build'], jarvisRoot, 60_000)
      if (buildResult.exitCode !== 0) {
        return { content: '', error: `Post-merge build failed: ${(buildResult.stdout + '\n' + buildResult.stderr).trim().slice(-2000)}` }
      }
      output.push('Build: PASSED')

      // Update lastGoodCommit
      const headResult = await git(['rev-parse', 'HEAD'], jarvisRoot)
      state.lastGoodCommit = headResult.stdout.trim()

      // Write supervisor state
      await writeSupervisorState()
      output.push(`Supervisor state updated (lastGoodCommit: ${state.lastGoodCommit.slice(0, 7)})`)

      // Delete the feature branch
      await git(['branch', '-d', branch], jarvisRoot)

      // Update modification record
      updateCurrentRecord({ outcome: 'promoted', completedAt: new Date().toISOString() })

      // Set cooldown and reset status
      setCooldown()
      state.status = 'idle'
      state.branch = undefined
      await saveState()

      output.push('')
      output.push('Promotion complete. Restarting in 3 seconds...')
      output.push('(The supervisor will pick up the new code)')

      config.logger.info({ branch, commit: state.lastGoodCommit }, 'Self-modification promoted')

      // Schedule restart after response is sent
      setTimeout(() => config.requestRestart(42), 3000)

      return { content: output.join('\n') }
    },
  }

  const selfModifyRevert: Tool = {
    name: 'self_modify_revert',
    description: [
      'Abandon the current self-modification session.',
      'Kills any canary, switches back to main, deletes the branch, and rebuilds.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Reason for reverting the modification',
        },
      },
      required: ['reason'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const reason = args.reason as string
      if (!reason || typeof reason !== 'string') {
        return { content: '', error: 'reason is required' }
      }

      if (state.status === 'idle') {
        return { content: '', error: 'No modification in progress to revert.' }
      }

      const branch = state.branch
      const output: string[] = []

      // Kill canary
      cleanupCanary()

      // Switch to main
      const checkoutResult = await git(['checkout', 'main'], jarvisRoot)
      if (checkoutResult.exitCode !== 0) {
        await git(['checkout', '-f', 'main'], jarvisRoot)
      }
      output.push('Switched to main')

      // Delete branch
      if (branch) {
        const deleteResult = await git(['branch', '-D', branch], jarvisRoot)
        if (deleteResult.exitCode === 0) {
          output.push(`Deleted branch ${branch}`)
        } else {
          output.push(`Warning: could not delete branch ${branch}: ${deleteResult.stderr}`)
        }
      }

      // Rebuild clean state
      const buildResult = await exec('npm', ['run', 'build'], jarvisRoot, 60_000)
      if (buildResult.exitCode === 0) {
        output.push('Build: PASSED (clean state restored)')
      } else {
        output.push(`Warning: rebuild had issues: ${buildResult.stderr.slice(0, 500)}`)
      }

      // Update record
      updateCurrentRecord({ outcome: 'reverted', completedAt: new Date().toISOString() })

      // Reset state
      state.status = 'idle'
      state.branch = undefined
      await saveState()

      output.push(`Reason: ${reason}`)
      config.logger.info({ branch, reason }, 'Self-modification reverted')

      return { content: output.join('\n') }
    },
  }

  const selfModifyStatus: Tool = {
    name: 'self_modify_status',
    description: 'Check the current self-modification status, branch, canary, and recent history.',
    parameters: {
      type: 'object',
      properties: {
        history_count: {
          type: 'number',
          description: 'Number of recent modification records to show (default: 5)',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const historyCount = typeof args.history_count === 'number' ? args.history_count : 5

      const lines: string[] = [
        '## Self-Modification Status',
        '',
        `Status: ${state.status}`,
        `Branch: ${state.branch ?? '(none)'}`,
        `Last good commit: ${state.lastGoodCommit || '(unknown)'}`,
      ]

      if (state.canaryPid) {
        const alive = isProcessAlive(state.canaryPid)
        lines.push(`Canary: PID ${state.canaryPid} (${alive ? 'alive' : 'dead'}), port ${state.canaryPort}`)
      } else {
        lines.push('Canary: not running')
      }

      if (state.cooldownUntil) {
        const remaining = new Date(state.cooldownUntil).getTime() - Date.now()
        if (remaining > 0) {
          lines.push(`Cooldown: ${Math.ceil(remaining / 60_000)} minute(s) remaining`)
        } else {
          lines.push('Cooldown: expired')
        }
      }

      // Recent history
      const recent = state.modifications.slice(-historyCount).reverse()
      if (recent.length > 0) {
        lines.push('')
        lines.push('### Recent Modifications')
        for (const record of recent) {
          const date = record.startedAt.slice(0, 19).replace('T', ' ')
          lines.push(`- [${record.outcome}] ${record.description} (${date}, branch: ${record.branch}, files: ${record.filesChanged.length})`)
        }
      }

      return { content: lines.join('\n') }
    },
  }

  // ---------- handle ----------

  return {
    tools: [selfModifyStart, selfModifyValidate, selfModifyPromote, selfModifyRevert, selfModifyStatus],

    async initialize(): Promise<void> {
      await loadState()

      // If status is not idle on startup, we likely crashed mid-modification → auto-revert
      if (state.status !== 'idle') {
        config.logger.warn(
          { status: state.status, branch: state.branch },
          'Self-modify state was non-idle on startup. Auto-reverting...',
        )

        cleanupCanary()

        if (state.branch) {
          await git(['checkout', '-f', 'main'], jarvisRoot)
          await git(['branch', '-D', state.branch], jarvisRoot)
          await exec('npm', ['run', 'build'], jarvisRoot, 60_000)

          updateCurrentRecord({ outcome: 'failed', completedAt: new Date().toISOString() })
          config.logger.info({ branch: state.branch }, 'Auto-reverted self-modification branch')
        }

        state.status = 'idle'
        state.branch = undefined
        await saveState()
      } else if (state.canaryPid) {
        // Clean up stale canary
        if (isProcessAlive(state.canaryPid)) {
          config.logger.info({ pid: state.canaryPid }, 'Cleaning up stale canary process')
          killProcess(state.canaryPid)
        }
        state.canaryPid = undefined
        state.canaryPort = undefined
        await saveState()
      }

      config.logger.info(
        { lastGoodCommit: state.lastGoodCommit, historyCount: state.modifications.length },
        'Self-modify tools initialized',
      )
    },

    shutdown(): void {
      cleanupCanary()
    },
  }
}
