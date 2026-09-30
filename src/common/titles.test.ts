import { afterEach, beforeEach, expect, test } from 'bun:test'
import { titles } from './titles.ts'

let originalNames: Record<string, string>
beforeEach(() => { originalNames = titles.names; titles.names = {} })
afterEach(() => { titles.names = originalNames })

// A local wall-clock time as the ISO string records carry.
let at = (h: number, m: number) => new Date(2026, 8, 28, h, m).toISOString()

test('headers: time and who wrote the block, with the catalog model name (else its id) and effort', () => {
	titles.names = { 'anthropic/claude-opus-5-5': 'Opus 5.5' }
	expect(titles.title({ type: 'prompt', text: 'hi', ts: at(10, 49) })).toBe('10:49 You')
	expect(titles.title({ type: 'prompt', text: 'hi', from: '12-abc', label: 'tab 3: Review', ts: at(9, 5) })).toBe('09:05 Message from tab 3: Review')
	expect(titles.title({ type: 'text', text: 'x', model: 'anthropic/claude-opus-5-5', ts: at(10, 52) })).toBe('10:52 Hal (Opus 5.5)')
	expect(titles.title({ type: 'thinking', text: 'x', model: 'openai/gpt-5.5', effort: 'high', ts: at(23, 0) })).toBe('23:00 Hal (openai/gpt-5.5, thinking high)')
	expect(titles.title({ type: 'thinking', text: 'x', model: 'anthropic/claude-opus-5-5', ts: at(0, 1) })).toBe('00:01 Hal (Opus 5.5, thinking)')
})

test('old records without model, effort or time still get a header', () => {
	expect(titles.title({ type: 'text', text: 'x' })).toBe('Hal')
	expect(titles.title({ type: 'thinking', text: 'x' })).toBe('Hal (thinking)')
	expect(titles.title({ type: 'prompt', text: 'x' })).toBe('You')
	expect(titles.title({ type: 'command', text: '/help' })).toBe('You')
	expect(titles.title({ type: 'output', text: 'x' })).toBeUndefined()
})
