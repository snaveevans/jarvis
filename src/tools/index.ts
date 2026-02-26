import { askUserTool } from './ask-user.ts'
import { editTool } from './edit.ts'
import { globTool } from './glob.ts'
import { grepTool } from './grep.ts'
import { readTool } from './read.ts'
import { readFileTool } from './read-file.ts'
import { shellTool } from './shell.ts'
import { subAgentTool } from './sub-agent.ts'
import { todoListTool } from './todo-list.ts'
import { webFetchTool } from './web-fetch.ts'
import { writeTool } from './write.ts'
import type { Tool, ToolResult, ToolCall, ToolExecutionContext } from './types.ts'
import { DEFAULT_TOOL_TIMEOUT_MS, withTimeout } from './common.ts'

export const availableTools: Tool[] = [
  readTool,
  globTool,
  grepTool,
  editTool,
  writeTool,
  shellTool,
  askUserTool,
  todoListTool,
  webFetchTool,
  subAgentTool,
  readFileTool,
]

export function getToolDefinitions(): Array<{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}> {
  return availableTools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

export async function executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
  const tool = availableTools.find(t => t.name === call.function.name)

  if (!tool) {
    return {
      content: '',
      error: `Tool not found: ${call.function.name}`,
    }
  }

  try {
    const args = JSON.parse(call.function.arguments)
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    return await withTimeout(
      async () => await tool.execute(args, context),
      timeoutMs,
      tool.name
    )
  } catch (error) {
    return {
      content: '',
      error: `Failed to execute tool ${call.function.name}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export { readFileTool }
export type { Tool, ToolResult, ToolCall }
