import type { Tool, ToolResult } from './types.ts'

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
type TodoPriority = 'low' | 'medium' | 'high'

interface TodoItem {
  id?: string
  content: string
  status: TodoStatus
  priority: TodoPriority
}

interface TodoItemInput {
  id?: unknown
  content?: unknown
  title?: unknown
  status?: unknown
  done?: unknown
  priority?: unknown
}

const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']
const VALID_PRIORITIES: TodoPriority[] = ['low', 'medium', 'high']

let activeTodos: TodoItem[] = []

function formatTodo(todo: TodoItem, index: number): string {
  const idPrefix = todo.id ? `${todo.id}: ` : ''
  return `${index + 1}. [${todo.status}] (${todo.priority}) ${idPrefix}${todo.content}`
}

function validateTodoItem(item: TodoItem): string | null {
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

function normalizeTodoItem(rawItem: unknown): {
  item?: TodoItem
  error?: string
} {
  if (!rawItem || typeof rawItem !== 'object') {
    return {
      error: 'Each todo item must be an object',
    }
  }

  const itemInput = rawItem as TodoItemInput

  const content = typeof itemInput.content === 'string' && itemInput.content.trim().length > 0
    ? itemInput.content.trim()
    : typeof itemInput.title === 'string' && itemInput.title.trim().length > 0
      ? itemInput.title.trim()
      : ''

  if (!content) {
    return {
      error: 'Todo content must be non-empty (provide `content` or `title`)',
    }
  }

  let status: TodoStatus = 'pending'
  if (typeof itemInput.status === 'string' && VALID_STATUSES.includes(itemInput.status as TodoStatus)) {
    status = itemInput.status as TodoStatus
  } else if (typeof itemInput.done === 'boolean') {
    status = itemInput.done ? 'completed' : 'pending'
  }

  const priority = typeof itemInput.priority === 'string' &&
      VALID_PRIORITIES.includes(itemInput.priority as TodoPriority)
    ? itemInput.priority as TodoPriority
    : 'medium'

  const id = typeof itemInput.id === 'string' && itemInput.id.trim().length > 0
    ? itemInput.id.trim()
    : undefined

  return {
    item: {
      id,
      content,
      status,
      priority,
    },
  }
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
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            title: { type: 'string' },
            status: {
              type: 'string',
              enum: VALID_STATUSES,
            },
            done: { type: 'boolean' },
            priority: {
              type: 'string',
              enum: VALID_PRIORITIES,
            },
          },
        },
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const itemsInput = args.items as unknown

    if (itemsInput === undefined) {
      return {
        content: activeTodos.length > 0
          ? activeTodos.map(formatTodo).join('\n')
          : '(todo list is empty)',
      }
    }

    if (!Array.isArray(itemsInput)) {
      return {
        content: '',
        error: 'items must be an array',
      }
    }

    const normalizedItems: TodoItem[] = []
    for (const rawItem of itemsInput) {
      const normalized = normalizeTodoItem(rawItem)
      if (normalized.error) {
        return {
          content: '',
          error: normalized.error,
        }
      }

      const item = normalized.item as TodoItem
      const validationError = validateTodoItem(item)
      if (validationError) {
        return {
          content: '',
          error: validationError,
        }
      }

      normalizedItems.push(item)
    }

    const inProgressCount = normalizedItems.filter(item => item.status === 'in_progress').length
    if (inProgressCount > 1) {
      return {
        content: '',
        error: 'Only one todo item may be in_progress at a time',
      }
    }

    activeTodos = normalizedItems
    return {
      content: activeTodos.map(formatTodo).join('\n'),
    }
  },
}
