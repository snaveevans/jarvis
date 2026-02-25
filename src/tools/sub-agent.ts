import type { Tool, ToolResult } from './types.ts'

export const subAgentTool: Tool = {
  name: 'sub_agent',
  description: 'Delegate a complex task to a specialized sub-agent interface.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Task prompt to delegate.',
      },
      subagent_type: {
        type: 'string',
        description: 'Type of sub-agent to use.',
      },
      task_id: {
        type: 'string',
        description: 'Optional existing task ID to resume.',
      },
    },
    required: ['prompt', 'subagent_type'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = args.prompt as string | undefined
    const subagentType = args.subagent_type as string | undefined
    const taskId = args.task_id as string | undefined

    if (!prompt || !subagentType) {
      return {
        content: '',
        error: 'Missing required parameters: prompt, subagent_type',
      }
    }

    const summary = [
      'Sub-agent request captured.',
      `Type: ${subagentType}`,
      `Task ID: ${taskId ?? '(new)'}`,
      `Prompt: ${prompt}`,
      'Note: Sub-agent runtime is not yet wired in this client.',
    ].join('\n')

    return {
      content: summary,
    }
  },
}
