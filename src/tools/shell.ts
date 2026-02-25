import { exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'

import type { Tool, ToolResult } from './types.ts'
import {
  capOutput,
  DEFAULT_TOOL_TIMEOUT_MS,
  getWorkspaceRoot,
  resolveWorkspacePath,
} from './common.ts'

const exec = promisify(execCallback)

const BLOCKED_COMMAND_PATTERNS = [
  /\b(cat|sed|awk)\b/,
  /\b(vim|nano|less|more)\b/,
  /\bgit\s+push\b.*(--force|-f)\b/,
  /\b--no-verify\b/,
  /\bgit\s+rebase\b.*\s-i\b/,
  /\bgit\s+config\b/,
  />\s*[^\s]/,
]

function parseTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TOOL_TIMEOUT_MS
  }

  return Math.floor(value)
}

export const shellTool: Tool = {
  name: 'shell',
  description: 'Run a shell command with timeout and output caps.',
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
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string | undefined
    const workdir = args.workdir as string | undefined
    const timeout = parseTimeout(args.timeout)

    if (!command || command.trim().length === 0) {
      return {
        content: '',
        error: 'Missing required parameter: command',
      }
    }

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
