import { parentPort } from 'node:worker_threads'
import path from 'node:path'
import { stat, readFile } from 'node:fs/promises'
import fg from 'fast-glob'

import type { WorkerRequest, WorkerResponse } from './types.ts'

if (!parentPort) {
  throw new Error('search-worker must be run as a worker thread')
}

const MAX_GLOB_RESULTS = 1_000
const MAX_GREP_MATCHES = 1_000
const MAX_OUTPUT_CHARACTERS = 50_000
const MAX_OUTPUT_LINES = 2_000
const MAX_LINE_LENGTH = 2_000

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line
  return `${line.slice(0, MAX_LINE_LENGTH)} ...[line truncated]`
}

function capOutput(output: string): string {
  const lines = output.split('\n')
  let truncated = false

  const boundedLines = lines.slice(0, MAX_OUTPUT_LINES).map(truncateLine)
  if (lines.length > MAX_OUTPUT_LINES) truncated = true

  let boundedOutput = boundedLines.join('\n')
  if (boundedOutput.length > MAX_OUTPUT_CHARACTERS) {
    boundedOutput = boundedOutput.slice(0, MAX_OUTPUT_CHARACTERS)
    truncated = true
  }

  if (truncated) boundedOutput += '\n... [output truncated]'
  return boundedOutput
}

async function handleGlob(params: Record<string, unknown>): Promise<string> {
  const pattern = params.pattern as string
  const searchRoot = params.searchRoot as string
  const workspaceRoot = params.workspaceRoot as string

  const matches = await fg(pattern, {
    cwd: searchRoot,
    absolute: true,
    dot: false,
    onlyFiles: false,
    unique: true,
  })

  const matchesWithMtime = await Promise.all(
    matches.map(async match => {
      try {
        const fileStats = await stat(match)
        return { match, mtimeMs: fileStats.mtimeMs }
      } catch {
        return { match, mtimeMs: 0 }
      }
    })
  )

  matchesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const limited = matchesWithMtime.slice(0, MAX_GLOB_RESULTS)
  const outputLines = limited.map(entry => path.relative(workspaceRoot, entry.match))

  if (matchesWithMtime.length > MAX_GLOB_RESULTS) {
    outputLines.push('... [results truncated]')
  }

  return capOutput(outputLines.join('\n') || '(no matches)')
}

async function handleGrep(params: Record<string, unknown>): Promise<string> {
  const pattern = params.pattern as string
  const include = (params.include as string | undefined) ?? '**/*'
  const searchRoot = params.searchRoot as string
  const workspaceRoot = params.workspaceRoot as string

  const regex = new RegExp(pattern)

  const files = await fg(include, {
    cwd: searchRoot,
    absolute: true,
    onlyFiles: true,
    dot: false,
    unique: true,
  })

  const matches: string[] = []
  for (const file of files) {
    if (matches.length >= MAX_GREP_MATCHES) break

    let content: string
    try {
      content = await readFile(file, 'utf-8')
    } catch {
      continue
    }

    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      if (matches.length >= MAX_GREP_MATCHES) break

      const line = lines[index]
      if (!regex.test(line)) continue

      const relativePath = path.relative(workspaceRoot, file)
      matches.push(`${relativePath}:${index + 1}: ${line}`)
    }
  }

  if (matches.length >= MAX_GREP_MATCHES) {
    matches.push('... [matches truncated]')
  }

  return capOutput(matches.join('\n') || '(no matches)')
}

const handlers: Record<string, (params: Record<string, unknown>) => Promise<string>> = {
  glob: handleGlob,
  grep: handleGrep,
}

parentPort.on('message', async (request: WorkerRequest) => {
  const response: WorkerResponse = { requestId: request.requestId }

  try {
    const handler = handlers[request.method]
    if (!handler) {
      response.error = `Unknown method: ${request.method}`
    } else {
      response.result = await handler(request.params)
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }

  parentPort!.postMessage(response)
})
