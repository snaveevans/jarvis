export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  stream?: boolean
  tools?: Tool[]
  tool_choice?: 'auto' | 'none' | ToolChoice
  response_format?: { type: 'json_object' | 'json_schema' }
}

export interface Tool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolChoice {
  type: 'function'
  function: {
    name: string
  }
}

export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Choice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface Choice {
  index: number
  message: ChatMessage
  finish_reason: string | null
}

export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: ChunkChoice[]
}

export interface ChunkChoice {
  index: number
  delta: Partial<ChatMessage>
  finish_reason: string | null
}

export interface Model {
  id: string
  object: string
  created: number
  owned_by: string
}
