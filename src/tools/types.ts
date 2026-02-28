export interface ToolResult {
  content: string
  error?: string
}

export interface ToolExecutionContext {
  sessionId: string
  endpointKind: string
  searchPool?: {
    glob(params: { pattern: string, searchRoot: string, workspaceRoot: string }): Promise<string>
    grep(params: { pattern: string, include?: string, searchRoot: string, workspaceRoot: string }): Promise<string>
  }
  shellPool?: {
    exec(job: { command: string, cwd: string, timeout: number, maxBuffer: number }): Promise<{ stdout: string, stderr: string, exitCode: number, durationMs: number }>
  }
  signal?: AbortSignal
  requestRestart?: (exitCode: number) => void
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  timeoutMs?: number
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<ToolResult>
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}
