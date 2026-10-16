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
	expect(titles.title({ type: 'prompt', text: 'hi', from: '12-abc', label: 'tab 3 · 12-abc · Review', delivery: 'now', ts: at(9, 5) })).toBe('09:05 From 12-abc (tab 3, steering)')
	expect(titles.title({ type: 'text', text: 'x', model: 'anthropic/claude-opus-5-5', effort: 'medium', ts: at(10, 52) })).toBe('10:52 Hal (Opus 5.5)')
	expect(titles.title({ type: 'text', text: 'Agree? <question>Agree?</question>', model: 'anthropic/claude-opus-5-5', effort: 'medium', ts: at(10, 52) })).toBe('10:52 Hal (Opus 5.5, question)')
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
	expect(titles.title({ type: 'command', text: '/help', output: 'x' })).toBe('/help')
	expect(titles.title({ type: 'command', text: '/help' })).toBeUndefined()
	expect(titles.title({ type: 'output', text: 'x' })).toBeUndefined()
})

test('folded messages identify the sender before the summary, keeping full attribution in details', () => {
	let item = { type: 'prompt' as const, text: 'Done', from: '163-gad', label: 'tab 4 · 163-gad · Review', summary: 'Report completion', advisory: true as const }
	expect(titles.messageHead(item)).toBe('From 163-gad (tab 4): Report completion')
	expect(titles.who(item)).toBe('From 163-gad (tab 4)')
	expect(titles.messageHead({ ...item, label: undefined })).toBe('From 163-gad: Report completion')
})

test('subagent reports show their outcome after sender identity; ordinary chatter is unchanged', () => {
	let item = { type: 'prompt' as const, text: '<question>Which format?</question>', from: '07-kim', label: 'tab 124 · 07-kim · Review', summary: 'Which format?', report: 'question' as const, ts: at(19, 12) }
	expect(titles.messageHead(item)).toBe('From 07-kim (tab 124, question): Which format?')
	expect(titles.title(item)).toBe('19:12 From 07-kim (tab 124, question): Which format?')
	expect(titles.messageHead({ ...item, report: 'summary', summary: 'Import added' })).toBe('From 07-kim (tab 124, done): Import added')
	expect(titles.messageHead({ ...item, report: undefined })).toBe('From 07-kim (tab 124): Which format?')
})

test('compact cards retain identity and the first content line; only real outcome tags label Hal', () => {
	expect(titles.compact({ type: 'prompt', from: '176-ict', label: 'tab 9 · 176-ict · Review', text: '\nIndex released.\nMore detail' })).toBe('From 176-ict (tab 9): Index released.')
	expect(titles.compact({ type: 'prompt', text: '\nPlease check this\nMore detail' })).toBe('You: Please check this')
	expect(titles.compact({ type: 'text', text: 'Updated headers.\n<summary>Updated</summary>' })).toBe('Hal (done): Updated headers.')
	expect(titles.compact({ type: 'text', text: '<question>Which format?</question>' })).toBe('Hal (question): Which format?')
	for (let text of ['Working on it.', '`<question>Example</question>`', '```\n<summary>Example</summary>\n```']) expect(titles.who({ type: 'text', text })).toBe('Hal')
	expect(titles.who({ type: 'text', text: '<summary>Updated</summary>', interrupted: true })).toBe('Hal')
})

test('receipts distinguish inbox delivery from model history without marking immediate messages', () => {
	let prompt = { type: 'prompt' as const, text: 'change direction' }
	for (let flags of [{ delivery: 'next-round' as const }, { advisory: true as const, from: 'other', delivery: 'next-round' as const }, { delivery: 'after-turn' as const }, { queuedAt: at(19, 12) }]) {
		expect(titles.receipt({ ...prompt, ...flags, waiting: true })).toBe(1)
		expect(titles.receipt({ ...prompt, ...flags })).toBe(2)
	}
	expect(titles.receipt(prompt)).toBe(0)
	expect(titles.receipt({ ...prompt, delivery: 'now' })).toBe(0)
	expect(titles.title({ ...prompt, delivery: 'next-round', waiting: true })).toBe('You (next round)')
	expect(titles.title({ ...prompt, delivery: 'after-turn' })).toBe('You (queued)')
})

test('background reports carry command status rather than message receipts', () => {
	for (let label of ['bash #19', 'bash #t19', 'bash b123abc']) {
		for (let waiting of [true, undefined] as const) {
			expect(titles.receipt({ type: 'prompt', text: '[exit 1]\nfailed', label, from: 'self', delivery: 'next-round', waiting })).toBe(0)
		}
	}
})
