import { afterEach, beforeEach, expect, test } from 'bun:test'
import { titles } from './titles.ts'

let original = { names: titles.names, defaults: titles.defaults }
beforeEach(() => { titles.names = {}; titles.defaults = {} })
afterEach(() => { Object.assign(titles, original) })

// A local wall-clock time as the ISO string records carry.
let at = (h: number, m: number) => { let d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString() }

test('headers: time and who wrote the block, the short model name (else its id) and any effort off the default (task r7r)', () => {
	titles.names = { 'anthropic/claude-opus-5-5': 'Claude Opus 5.5', 'openai/gpt-6.1-sol': 'GPT-6.1 Sol', 'openai/gpt-5.5': 'GPT-5.5' }
	titles.defaults = { 'anthropic/claude-opus-5-5': 'medium' }
	expect(titles.title({ type: 'prompt', text: 'hi', ts: at(10, 49) })).toBe('10:49 You')
	expect(titles.title({ type: 'prompt', text: 'hi', from: '12-abc', label: 'tab 3: Review', ts: at(9, 5) })).toBe('09:05 Message from tab 3: Review')
	expect(titles.title({ type: 'text', text: 'x', model: 'anthropic/claude-opus-5-5', effort: 'medium', ts: at(10, 52) })).toBe('10:52 Hal (Opus 5.5)')
	expect(titles.title({ type: 'text', text: 'x', model: 'openai/gpt-6.1-sol', effort: 'high', ts: at(10, 52) })).toBe('10:52 Hal (Sol 6.1 high)')
	expect(titles.title({ type: 'text', text: 'x', model: 'openai/gpt-5.5', ts: at(10, 52) })).toBe('10:52 Hal (GPT-5.5)')
	expect(titles.title({ type: 'thinking', text: 'x', model: 'openai/gpt-5.5', effort: 'high', ts: at(23, 0) })).toBe('23:00 Thinking')
	expect(titles.modelLabel('anthropic/claude-opus-5-5', 'high', true)).toBe('Claude Opus 5.5 high')
})

test('a header from another day puts the date before the time', () => {
	expect(titles.title({ type: 'prompt', text: 'hi', ts: new Date(2020, 9, 2, 8, 5).toISOString() })).toBe('2 Oct 08:05 You')
})

test('old records without model, effort or time still get a header', () => {
	expect(titles.title({ type: 'text', text: 'x' })).toBe('Hal')
	expect(titles.title({ type: 'thinking', text: 'x' })).toBe('Thinking')
	expect(titles.title({ type: 'prompt', text: 'x' })).toBe('You')
	expect(titles.title({ type: 'command', text: '/help' })).toBe('You')
	expect(titles.title({ type: 'output', text: 'x' })).toBeUndefined()
})

test('folded messages identify the sender before the summary, keeping full attribution in details', () => {
	let item = { type: 'prompt' as const, text: 'Done', from: '163-gad', label: 'tab 4 · 163-gad · Review', summary: 'Report completion', advisory: true as const }
	expect(titles.messageHead(item)).toBe('From tab 4 (163-gad) (next round): Report completion')
	expect(titles.who(item)).toBe('From tab 4 (163-gad), Review (next round)')
	expect(titles.messageHead({ ...item, label: undefined })).toBe('From 163-gad (next round): Report completion')
})
