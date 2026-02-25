import type { Tool, ToolResult } from './types.ts'

interface AskUserOption {
  label: string
  description?: string
}

function formatOption(option: AskUserOption, index: number): string {
  const description = option.description ? ` - ${option.description}` : ''
  return `${index + 1}. ${option.label}${description}`
}

export const askUserTool: Tool = {
  name: 'ask_user',
  description: 'Request clarification or a decision from the user.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Question text for the user.',
      },
      options: {
        type: 'array',
        description: 'Optional list of selectable options.',
      },
      multiple: {
        type: 'boolean',
        description: 'Whether multiple selections are allowed.',
      },
    },
    required: ['question'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const question = args.question as string | undefined
    const options = Array.isArray(args.options) ? (args.options as AskUserOption[]) : []
    const multiple = args.multiple === true

    if (!question || question.trim().length === 0) {
      return {
        content: '',
        error: 'Missing required parameter: question',
      }
    }

    const optionLines = options.map(formatOption)
    const response = [
      'ASK_USER_REQUIRED',
      `Question: ${question}`,
      optionLines.length > 0 ? `Options:\n${optionLines.join('\n')}` : 'Options: (freeform)',
      `Multiple selection allowed: ${multiple ? 'yes' : 'no'}`,
    ].join('\n')

    return {
      content: response,
    }
  },
}
