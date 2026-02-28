import { describe, test } from 'node:test'
import assert from 'node:assert'

import { buildAutoContextBlock } from './helpers.ts'

import type { AutoContextItem } from './helpers.ts'

function makeItem(overrides: Partial<AutoContextItem> & { id: number }): AutoContextItem {
  return {
    content: `Memory ${overrides.id}`,
    type: 'fact',
    tokenCount: 10,
    createdAt: '2026-01-15 12:00:00',
    ...overrides,
  }
}

describe('buildAutoContextBlock', () => {
  test('returns undefined for empty inputs', () => {
    const result = buildAutoContextBlock([], [])
    assert.equal(result, undefined)
  })

  test('returns FTS results when no recent memories', () => {
    const fts = [makeItem({ id: 1, content: 'FTS match' })]
    const result = buildAutoContextBlock(fts, [])
    assert.ok(result)
    assert.match(result!, /FTS match/)
  })

  test('returns recent memories when no FTS results', () => {
    const recent = [makeItem({ id: 2, content: 'Recent pref', type: 'preference' })]
    const result = buildAutoContextBlock([], recent)
    assert.ok(result)
    assert.match(result!, /Recent pref/)
  })

  test('deduplicates by ID — FTS takes priority', () => {
    const shared = makeItem({ id: 5, content: 'Shared memory' })
    const fts = [shared]
    const recent = [shared, makeItem({ id: 6, content: 'Other recent' })]
    const result = buildAutoContextBlock(fts, recent)
    assert.ok(result)
    // Shared memory should appear once, plus the other recent
    const lines = result!.split('\n').filter(l => l.startsWith('- '))
    assert.equal(lines.length, 2)
    assert.match(lines[0], /Shared memory/)
    assert.match(lines[1], /Other recent/)
  })

  test('orders FTS results first, then recent', () => {
    const fts = [makeItem({ id: 1, content: 'FTS first' })]
    const recent = [makeItem({ id: 2, content: 'Recent second' })]
    const result = buildAutoContextBlock(fts, recent)
    assert.ok(result)
    const lines = result!.split('\n').filter(l => l.startsWith('- '))
    assert.equal(lines.length, 2)
    assert.match(lines[0], /FTS first/)
    assert.match(lines[1], /Recent second/)
  })

  test('enforces token budget', () => {
    const items = [
      makeItem({ id: 1, content: 'First', tokenCount: 100 }),
      makeItem({ id: 2, content: 'Second', tokenCount: 100 }),
      makeItem({ id: 3, content: 'Third', tokenCount: 100 }),
    ]
    const result = buildAutoContextBlock(items, [], 150)
    assert.ok(result)
    const lines = result!.split('\n').filter(l => l.startsWith('- '))
    assert.equal(lines.length, 1)
    assert.match(lines[0], /First/)
  })

  test('returns undefined when first item exceeds budget', () => {
    const items = [makeItem({ id: 1, content: 'Big', tokenCount: 200 })]
    const result = buildAutoContextBlock(items, [], 50)
    assert.equal(result, undefined)
  })

  test('includes type label in output lines', () => {
    const fts = [makeItem({ id: 1, content: 'A preference', type: 'preference' })]
    const result = buildAutoContextBlock(fts, [])
    assert.ok(result)
    assert.match(result!, /\[preference, 2026-01-15\]/)
  })

  test('uses "summary" label for conversation_summary type', () => {
    const fts = [makeItem({ id: 1, content: 'A summary', type: 'conversation_summary' })]
    const result = buildAutoContextBlock(fts, [])
    assert.ok(result)
    assert.match(result!, /\[summary, 2026-01-15\]/)
  })
})
