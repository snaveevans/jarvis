import { test, describe } from 'node:test'
import assert from 'node:assert'

import { buildSystemPrompt, createDispatcher } from './dispatcher.ts'
import { createInMemorySessionStore } from './sessions/store.ts'

import type { EndpointProfile, Endpoint, OutboundMessage, InboundMessage } from './endpoints/types.ts'
import type { ChatCompletionResponse, ChatMessage } from './llm/types.ts'

function makeProfile(overrides: Partial<EndpointProfile> = {}): EndpointProfile {
  return {
    kind: 'test',
    displayName: 'Test endpoint',
    responseStyle: 'Be helpful.',
    formatting: 'markdown',
    ...overrides,
  }
}

function makeMockEndpoint(profile?: EndpointProfile): Endpoint & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = []
  return {
    profile: profile ?? makeProfile(),
    sent,
    async send(message: OutboundMessage) {
      sent.push(message)
    },
  }
}

function makeMockClient(content: string = 'Hello back!') {
  return {
    async chat(_messages: ChatMessage[]): Promise<ChatCompletionResponse> {
      return {
        id: 'test',
        object: 'chat.completion',
        created: Date.now(),
        model: 'test-model',
        choices: [{
          index: 0,
          message: { role: 'assistant' as const, content },
          finish_reason: 'stop',
        }],
      }
    },
  }
}

describe('buildSystemPrompt', () => {
  test('includes endpoint profile details', () => {
    const profile = makeProfile({
      displayName: 'Telegram chat',
      responseStyle: 'Be concise.',
      maxMessageLength: 4096,
      formatting: 'markdown',
    })

    const result = buildSystemPrompt('Base prompt here.', profile)

    assert.ok(result.includes('Telegram chat'))
    assert.ok(result.includes('Be concise.'))
    assert.ok(result.includes('4096'))
    assert.ok(result.includes('markdown'))
    assert.ok(result.includes('Base prompt here.'))
  })

  test('omits max length when not set', () => {
    const profile = makeProfile({ maxMessageLength: undefined })
    const result = buildSystemPrompt('Base.', profile)

    assert.ok(!result.includes('Keep individual messages under'))
  })
})

describe('createDispatcher', () => {
  test('handleInbound sends response via endpoint', async () => {
    const store = createInMemorySessionStore()
    const client = makeMockClient('Test response')
    const endpoint = makeMockEndpoint()

    const dispatcher = createDispatcher({
      client,
      sessionStore: store,
      model: 'test-model',
      logger: { level: 'silent' },
    })
    dispatcher.registerEndpoint(endpoint)

    await dispatcher.handleInbound({
      text: 'Hello',
      sessionId: 'test:1',
      endpointKind: 'test',
      timestamp: new Date(),
    })

    assert.equal(endpoint.sent.length, 1)
    assert.equal(endpoint.sent[0].text, 'Test response')
    assert.equal(endpoint.sent[0].sessionId, 'test:1')
  })

  test('handleInbound creates session with system prompt', async () => {
    const store = createInMemorySessionStore()
    const client = makeMockClient()
    const endpoint = makeMockEndpoint()

    const dispatcher = createDispatcher({
      client,
      sessionStore: store,
      model: 'test-model',
      logger: { level: 'silent' },
    })
    dispatcher.registerEndpoint(endpoint)

    await dispatcher.handleInbound({
      text: 'Hi',
      sessionId: 'test:1',
      endpointKind: 'test',
      timestamp: new Date(),
    })

    const session = store.get('test:1')!
    assert.equal(session.messages[0].role, 'system')
    assert.ok(session.messages[0].content.includes('Test endpoint'))
  })

  test('handleInbound handles /clear command', async () => {
    const store = createInMemorySessionStore()
    const client = makeMockClient()
    const endpoint = makeMockEndpoint()

    const dispatcher = createDispatcher({
      client,
      sessionStore: store,
      model: 'test-model',
      logger: { level: 'silent' },
    })
    dispatcher.registerEndpoint(endpoint)

    // Create a session first
    store.getOrCreate('test:1', 'test')
    store.addMessage('test:1', { role: 'user', content: 'old message' })

    await dispatcher.handleInbound({
      text: '/clear',
      sessionId: 'test:1',
      endpointKind: 'test',
      timestamp: new Date(),
    })

    assert.equal(store.get('test:1'), undefined)
    assert.equal(endpoint.sent.length, 1)
    assert.equal(endpoint.sent[0].text, 'Conversation cleared.')
  })

  test('handleInbound stores conversation history', async () => {
    const store = createInMemorySessionStore()
    const client = makeMockClient('Reply 1')
    const endpoint = makeMockEndpoint()

    const dispatcher = createDispatcher({
      client,
      sessionStore: store,
      model: 'test-model',
      logger: { level: 'silent' },
    })
    dispatcher.registerEndpoint(endpoint)

    await dispatcher.handleInbound({
      text: 'Message 1',
      sessionId: 'test:1',
      endpointKind: 'test',
      timestamp: new Date(),
    })

    const session = store.get('test:1')!
    // system + user + assistant = 3 messages
    assert.equal(session.messages.length, 3)
    assert.equal(session.messages[1].content, 'Message 1')
    assert.equal(session.messages[2].content, 'Reply 1')
  })

  test('handleInbound removes user message on error', async () => {
    const store = createInMemorySessionStore()
    const client = {
      async chat(): Promise<ChatCompletionResponse> {
        throw new Error('LLM down')
      },
    }
    const endpoint = makeMockEndpoint()

    const dispatcher = createDispatcher({
      client,
      sessionStore: store,
      model: 'test-model',
      logger: { level: 'silent' },
    })
    dispatcher.registerEndpoint(endpoint)

    await dispatcher.handleInbound({
      text: 'Hello',
      sessionId: 'test:1',
      endpointKind: 'test',
      timestamp: new Date(),
    })

    const session = store.get('test:1')!
    // Only system message should remain (user message popped on error)
    assert.equal(session.messages.length, 1)
    assert.equal(session.messages[0].role, 'system')

    // Error message sent to endpoint
    assert.equal(endpoint.sent.length, 1)
    assert.ok(endpoint.sent[0].text.includes('LLM down'))
  })

  test('handleInbound ignores unknown endpoint kind', async () => {
    const store = createInMemorySessionStore()
    const client = makeMockClient()

    const dispatcher = createDispatcher({
      client,
      sessionStore: store,
      model: 'test-model',
      logger: { level: 'silent' },
    })

    // No endpoint registered — should not throw
    await dispatcher.handleInbound({
      text: 'Hello',
      sessionId: 'test:1',
      endpointKind: 'unknown',
      timestamp: new Date(),
    })
  })

  test('sendProactive sends through target endpoint', async () => {
    const store = createInMemorySessionStore()
    const client = makeMockClient('Proactive reply')
    const endpoint = makeMockEndpoint()

    const dispatcher = createDispatcher({
      client,
      sessionStore: store,
      model: 'test-model',
      logger: { level: 'silent' },
    })
    dispatcher.registerEndpoint(endpoint)

    await dispatcher.sendProactive({
      sessionId: 'test:cron',
      endpointKind: 'test',
      text: 'Time to check in!',
    })

    assert.equal(endpoint.sent.length, 1)
    assert.equal(endpoint.sent[0].text, 'Proactive reply')

    const session = store.get('test:cron')!
    assert.equal(session.messages.length, 3) // system + user + assistant
  })

  test('start calls listen on endpoints with listen method', async () => {
    const store = createInMemorySessionStore()
    const client = makeMockClient()

    let listenerCalled = false
    let stopCalled = false
    const endpoint: Endpoint = {
      profile: makeProfile(),
      async send() {},
      async listen(_handler) {
        listenerCalled = true
        return () => { stopCalled = true }
      },
    }

    const dispatcher = createDispatcher({
      client,
      sessionStore: store,
      model: 'test-model',
      logger: { level: 'silent' },
    })
    dispatcher.registerEndpoint(endpoint)

    const stop = await dispatcher.start()
    assert.ok(listenerCalled)

    stop()
    assert.ok(stopCalled)
  })
})
