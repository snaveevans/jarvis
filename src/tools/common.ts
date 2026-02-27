import path from 'node:path'
import os from 'node:os'
import { access } from 'node:fs/promises'

export function parsePositiveEnvInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return n > 0 ? n : fallback
}

export const DEFAULT_TOOL_TIMEOUT_MS = parsePositiveEnvInt('JARVIS_TOOLS_TIMEOUT_MS', 120_000)
export const MAX_OUTPUT_CHARACTERS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_OUTPUT_CHARACTERS', 50_000)
export const MAX_OUTPUT_LINES = parsePositiveEnvInt('JARVIS_TOOLS_MAX_OUTPUT_LINES', 2_000)
export const MAX_LINE_LENGTH = parsePositiveEnvInt('JARVIS_TOOLS_MAX_LINE_LENGTH', 2_000)

const WORKSPACE_ROOT = process.cwd()
const readFiles = new Set<string>()

function parseAllowedPaths(): string[] {
  const env = process.env.JARVIS_ALLOWED_PATHS
  if (env) {
    return env.split(',').map(p => path.resolve(p.trim()))
  }
  return [os.homedir()]
}

const ALLOWED_PATHS = parseAllowedPaths()

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT
}

export function getAllowedPaths(): string[] {
  return ALLOWED_PATHS
}

export function resolveWorkspacePath(inputPath: string): string {
  const resolvedPath = path.resolve(WORKSPACE_ROOT, inputPath)

  const isAllowed = ALLOWED_PATHS.some(allowed => {
    const rel = path.relative(allowed, resolvedPath)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  })

  if (!isAllowed) {
    throw new Error(
      `Path is outside allowed directories: ${inputPath} (allowed: ${ALLOWED_PATHS.join(', ')})`
    )
  }

  return resolvedPath
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function normalizePath(filePath: string): string {
  return path.normalize(filePath)
}

export function markFileAsRead(filePath: string): void {
  readFiles.add(normalizePath(filePath))
}

export function hasFileBeenRead(filePath: string): boolean {
  return readFiles.has(normalizePath(filePath))
}

export function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) {
    return line
  }

  return `${line.slice(0, MAX_LINE_LENGTH)} ...[line truncated]`
}

export function capOutput(output: string): string {
  const lines = output.split('\n')
  let truncated = false

  const boundedLines = lines.slice(0, MAX_OUTPUT_LINES).map(truncateLine)
  if (lines.length > MAX_OUTPUT_LINES) {
    truncated = true
  }

  let boundedOutput = boundedLines.join('\n')
  if (boundedOutput.length > MAX_OUTPUT_CHARACTERS) {
    boundedOutput = boundedOutput.slice(0, MAX_OUTPUT_CHARACTERS)
    truncated = true
  }

  if (truncated) {
    boundedOutput += '\n... [output truncated]'
  }

  return boundedOutput
}

export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  toolName: string
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Tool timed out after ${timeoutMs}ms: ${toolName}`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}
