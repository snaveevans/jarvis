import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'

import type { Tool, ToolResult, ToolExecutionContext } from './types.ts'
import {
  capOutput,
  DEFAULT_TOOL_TIMEOUT_MS,
  getWorkspaceRoot,
  resolveWorkspacePath,
} from './common.ts'

const exec = promisify(execCallback)

const BLOCKED_COMMAND_PATTERNS = [
  /\b(vim|nano|emacs|vi)\b/,
  /\b(less|more)\b/,
  /\bgit\s+push\b.*(--force|-f)\b/,
  /\b--no-verify\b/,
  /\bgit\s+rebase\b.*\s-i\b/,
]

function parseTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TOOL_TIMEOUT_MS
  }

  return Math.floor(value)
}

export const shellTool: Tool = {
  name: 'shell',
  description: 'Execute a shell command (bash). Use for: build, test, lint, git, install dependencies, run scripts, process text, and any system operation. Output is capped at ~50KB. Interactive commands (vim, less) are not supported.',
  timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to run.',
      },
      workdir: {
        type: 'string',
        description: 'Optional working directory path.',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (default: 120000).',
      },
    },
    required: ['command'],
  },
  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const command = args.command as string | undefined
    const workdir = args.workdir as string | undefined
    const timeout = parseTimeout(args.timeout)

    if (!command || command.trim().length === 0) {
      return {
        content: '',
        error: 'Missing required parameter: command',
      }
    }

    // Blocked command validation stays before pool dispatch
    for (const blockedPattern of BLOCKED_COMMAND_PATTERNS) {
      if (blockedPattern.test(command)) {
        return {
          content: '',
          error: `Blocked shell command pattern for safety: ${blockedPattern}`,
        }
      }
    }

    let cwd = getWorkspaceRoot()
    if (workdir) {
      try {
        cwd = resolveWorkspacePath(workdir)
      } catch (error) {
        return {
          content: '',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    // Delegate to shell pool if available
    if (context?.shellPool) {
      try {
        const result = await context.shellPool.exec({
          command,
          cwd,
          timeout,
          maxBuffer: 5 * 1024 * 1024,
        })

        if (result.exitCode !== 0) {
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
          return {
            content: capOutput(output),
            error: 'Shell command failed',
          }
        }

        return {
          content: capOutput([result.stdout, result.stderr].filter(Boolean).join('\n').trim()),
        }
      } catch (error) {
        return {
          content: '',
          error: `Shell command failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    // In-process fallback
    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        timeout,
        shell: '/bin/bash',
        maxBuffer: 5 * 1024 * 1024,
      })

      return {
        content: capOutput([stdout, stderr].filter(Boolean).join('\n').trim()),
      }
    } catch (error) {
      const shellError = error as {
        stdout?: string
        stderr?: string
        message?: string
      }
      const output = [shellError.stdout, shellError.stderr, shellError.message]
        .filter(Boolean)
        .join('\n')

      return {
        content: capOutput(output),
        error: 'Shell command failed',
      }
    }
  },
}
