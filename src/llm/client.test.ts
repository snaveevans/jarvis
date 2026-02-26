import { test, describe } from 'node:test'
import assert from 'node:assert'
import { LLMClient } from './client.ts'
import { LLMError, LLMRateLimitError, LLMAuthenticationError } from './errors.ts'

describe('LLMClient', () => {
  test('throws error when API key is not provided', () => {
    assert.throws(
      () => new LLMClient(),
      (err: unknown) => {
        return err instanceof LLMError && err.code === 'MISSING_API_KEY'
      }
    )
  })

  test('accepts API key from constructor', () => {
    const client = new LLMClient({ apiKey: 'test-key' })
    assert.ok(client)
  })

  test('uses default base URL', () => {
    const client = new LLMClient({ apiKey: 'test' })
    assert.ok(client)
  })

  test('accepts custom base URL', () => {
    const client = new LLMClient({
      apiKey: 'test',
      baseUrl: 'https://custom.api.com/v1',
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
      defaultModel: 'custom-model',
    })
    assert.ok(client)
  })

  test('strips minimax think tags for user-visible output', () => {
    const client = new LLMClient({
      apiKey: 'test',
      baseUrl: 'https://api.minimax.io/v1',
      provider: 'minimax',
    })
    const visible = client.toUserVisibleContent('<think>internal</think>Visible answer')
    assert.strictEqual(visible, 'Visible answer')
  })

  test('does not strip content for synthetic provider', () => {
    const client = new LLMClient({
      apiKey: 'test',
      provider: 'synthetic',
    })
    const visible = client.toUserVisibleContent('<think>internal</think>Visible answer')
    assert.strictEqual(visible, '<think>internal</think>Visible answer')
  })
})

describe('LLM Errors', () => {
  test('LLMError has correct properties', () => {
    const error = new LLMError('test message', 'TEST_CODE', 500)
    assert.strictEqual(error.message, 'test message')
    assert.strictEqual(error.code, 'TEST_CODE')
    assert.strictEqual(error.statusCode, 500)
    assert.strictEqual(error.name, 'LLMError')
  })

  test('LLMRateLimitError has correct properties', () => {
    const error = new LLMRateLimitError('rate limited')
    assert.strictEqual(error.message, 'rate limited')
    assert.strictEqual(error.code, 'RATE_LIMIT')
    assert.strictEqual(error.statusCode, 429)
    assert.strictEqual(error.name, 'LLMRateLimitError')
  })

  test('LLMAuthenticationError has correct properties', () => {
    const error = new LLMAuthenticationError('auth failed')
    assert.strictEqual(error.message, 'auth failed')
    assert.strictEqual(error.code, 'AUTHENTICATION')
    assert.strictEqual(error.statusCode, 401)
    assert.strictEqual(error.name, 'LLMAuthenticationError')
  })
})
