import type { Tool, ToolResult } from './types.ts'

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
type TodoPriority = 'low' | 'medium' | 'high'

interface TodoItemInput {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']
const VALID_PRIORITIES: TodoPriority[] = ['low', 'medium', 'high']

let activeTodos: TodoItemInput[] = []

function formatTodo(todo: TodoItemInput, index: number): string {
  return `${index + 1}. [${todo.status}] (${todo.priority}) ${todo.content}`
}

function validateTodoItem(item: TodoItemInput): string | null {
  if (!item.content || item.content.trim().length === 0) {
    return 'Todo content must be non-empty'
  }

  if (!VALID_STATUSES.includes(item.status)) {
    return `Invalid todo status: ${item.status}`
  }

  if (!VALID_PRIORITIES.includes(item.priority)) {
    return `Invalid todo priority: ${item.priority}`
  }

  return null
}

export const todoListTool: Tool = {
  name: 'todo_list',
  description: 'Track and update a visible multi-step todo list.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'List of todo items to set or replace.',
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const items = args.items as TodoItemInput[] | undefined

    if (!items) {
      return {
        content: activeTodos.length > 0
          ? activeTodos.map(formatTodo).join('\n')
          : '(todo list is empty)',
      }
    }

    if (!Array.isArray(items)) {
      return {
        content: '',
        error: 'items must be an array',
      }
    }

    for (const item of items) {
      const validationError = validateTodoItem(item)
      if (validationError) {
        return {
          content: '',
          error: validationError,
        }
      }
    }

    const inProgressCount = items.filter(item => item.status === 'in_progress').length
    if (inProgressCount > 1) {
      return {
        content: '',
        error: 'Only one todo item may be in_progress at a time',
      }
    }

    activeTodos = items
    return {
      content: activeTodos.map(formatTodo).join('\n'),
    }
  },
}
