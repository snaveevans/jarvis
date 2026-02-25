import path from 'node:path'
import { access } from 'node:fs/promises'

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000
export const MAX_OUTPUT_CHARACTERS = 50_000
export const MAX_OUTPUT_LINES = 2_000
export const MAX_LINE_LENGTH = 2_000

const WORKSPACE_ROOT = process.cwd()
const readFiles = new Set<string>()

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT
}

export function resolveWorkspacePath(inputPath: string): string {
  const resolvedPath = path.resolve(WORKSPACE_ROOT, inputPath)
  const relativePath = path.relative(WORKSPACE_ROOT, resolvedPath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Path is outside workspace: ${inputPath}`)
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
