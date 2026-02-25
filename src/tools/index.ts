import { readFileTool } from './read-file.ts'
import type { Tool, ToolResult, ToolCall } from './types.ts'

export const availableTools: Tool[] = [readFileTool]

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

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  const tool = availableTools.find(t => t.name === call.function.name)

  if (!tool) {
    return {
      content: '',
      error: `Tool not found: ${call.function.name}`,
    }
  }

  try {
    const args = JSON.parse(call.function.arguments)
    return await tool.execute(args)
  } catch (error) {
    return {
      content: '',
      error: `Failed to execute tool ${call.function.name}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export { readFileTool }
export type { Tool, ToolResult, ToolCall }
