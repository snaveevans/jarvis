import { test, describe } from 'node:test'
import assert from 'node:assert'
import { LLMClient } from './client.ts'
import { LLMError, LLMRateLimitError, LLMAuthenticationError } from './errors.ts'

describe('LLMClient', () => {
  test('throws error when API key is not provided', () => {
    const originalEnv = process.env.SYNTHETIC_API_KEY
    delete process.env.SYNTHETIC_API_KEY

    assert.throws(
      () => new LLMClient(),
      (err: unknown) => {
        return err instanceof LLMError && err.code === 'MISSING_API_KEY'
      }
    )

    if (originalEnv) {
      process.env.SYNTHETIC_API_KEY = originalEnv
    }
  })

  test('accepts API key from constructor', () => {
    const client = new LLMClient({ apiKey: 'test-key' })
    assert.ok(client)
  })

  test('accepts API key from environment variable', () => {
    const originalEnv = process.env.SYNTHETIC_API_KEY
    process.env.SYNTHETIC_API_KEY = 'env-test-key'

    const client = new LLMClient()
    assert.ok(client)

    if (originalEnv) {
      process.env.SYNTHETIC_API_KEY = originalEnv
    } else {
      delete process.env.SYNTHETIC_API_KEY
    }
  })

  test('uses default base URL', () => {
    const client = new LLMClient({ apiKey: 'test' })
    assert.ok(client)
  })

  test('accepts custom base URL', () => {
    const client = new LLMClient({
      apiKey: 'test',
      baseUrl: 'https://custom.api.com/v1'
    })
    assert.ok(client)
  })

  test('uses default model', () => {
    const client = new LLMClient({ apiKey: 'test' })
    assert.ok(client)
  })

  test('accepts custom default model', () => {
    const client = new LLMClient({
      apiKey: 'test',
      defaultModel: 'custom-model'
    })
    assert.ok(client)
  })
})

describe('LLM Errors', () => {
  test('LLMError has correct properties', () => {
    const error = new LLMError('test message', 'TEST_CODE', 500)
    assert.equal(error.message, 'test message')
    assert.equal(error.code, 'TEST_CODE')
    assert.equal(error.statusCode, 500)
    assert.equal(error.name, 'LLMError')
  })

  test('LLMRateLimitError has correct defaults', () => {
    const error = new LLMRateLimitError()
    assert.equal(error.message, 'Rate limit exceeded')
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.statusCode, 429)
    assert.equal(error.name, 'LLMRateLimitError')
  })

  test('LLMAuthenticationError has correct defaults', () => {
    const error = new LLMAuthenticationError()
    assert.equal(error.message, 'Invalid API key')
    assert.equal(error.code, 'AUTHENTICATION')
    assert.equal(error.statusCode, 401)
    assert.equal(error.name, 'LLMAuthenticationError')
  })

  test('errors accept custom messages', () => {
    const rateLimitError = new LLMRateLimitError('Custom rate limit message')
    assert.equal(rateLimitError.message, 'Custom rate limit message')

    const authError = new LLMAuthenticationError('Custom auth message')
    assert.equal(authError.message, 'Custom auth message')
  })
})
