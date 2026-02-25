export class LLMError extends Error {
  readonly code: string
  readonly statusCode?: number

  constructor(message: string, code: string, statusCode?: number) {
    super(message)
    this.name = 'LLMError'
    this.code = code
    this.statusCode = statusCode
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(message: string = 'Rate limit exceeded') {
    super(message, 'RATE_LIMIT', 429)
    this.name = 'LLMRateLimitError'
  }
}

export class LLMAuthenticationError extends LLMError {
  constructor(message: string = 'Invalid API key') {
    super(message, 'AUTHENTICATION', 401)
    this.name = 'LLMAuthenticationError'
  }
}

export class LLMInvalidRequestError extends LLMError {
  constructor(message: string) {
    super(message, 'INVALID_REQUEST', 400)
    this.name = 'LLMInvalidRequestError'
  }
}

export class LLMModelNotFoundError extends LLMError {
  constructor(model: string) {
    super(`Model not found: ${model}`, 'MODEL_NOT_FOUND', 404)
    this.name = 'LLMModelNotFoundError'
  }
}
