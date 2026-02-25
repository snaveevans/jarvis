export { LLMClient } from './client.ts'
export type { LLMClientConfig } from './client.ts'
export { chatWithTools } from './chat-with-tools.ts'
export type {
  ChatWithToolsClient,
  ChatWithToolsOptions,
  ToolCallObservation,
} from './chat-with-tools.ts'
export type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Choice,
  ChunkChoice,
  Tool,
  ToolCall,
  ToolChoice,
  Model,
} from './types.ts'
export {
  LLMError,
  LLMRateLimitError,
  LLMAuthenticationError,
  LLMInvalidRequestError,
  LLMModelNotFoundError,
} from './errors.ts'
