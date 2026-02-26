export interface ToolResult {
  content: string
  error?: string
}

export interface ToolExecutionContext {
  sessionId: string
  endpointKind: string
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
