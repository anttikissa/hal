import { expect, test } from 'bun:test'
import { colors } from './colors.ts'
import { blocks } from './blocks.ts'
import { renderHistory, type HistoryRenderContext } from './render-history.ts'
import type { Tab } from '../app.ts'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
}

function context(): HistoryRenderContext {
	return {
		blockCache: new WeakMap(),
		cursorTick: 0,
		workingSessions: new Map(),
		sessionLabel: (sessionId) => sessionId,
		sessionLabelVersion: 0,
	}
}

function tab(history: Tab['history']): Tab {
	return {
		sessionId: 'test',
		name: 'test',
		history,
		inputHistory: [],
		loaded: true,
		inputDraft: '',
		doneUnseen: false,
		parentEntryCount: 0,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '/tmp',
		model: 'test',
	}
}

test('adjacent assistant blocks use a Hal-colored rule separator', () => {
	colors.load()
	const lines: string[] = []
	renderHistory.renderLines(lines, tab([
		{ type: 'assistant', text: 'first' },
		{ type: 'assistant', text: 'second', synthetic: true },
	]), 20, context())

	const clean = lines.map(stripAnsi)
	const firstIndex = clean.findIndex((line) => line.includes('first'))
	const ruleIndex = firstIndex + 2
	const secondIndex = ruleIndex + 2

	expect(firstIndex).toBeGreaterThanOrEqual(0)
	expect(clean[ruleIndex - 1]).toBe('')
	expect(clean[ruleIndex + 1]).toBe('')
	expect(clean[ruleIndex]).toBe('─'.repeat(20))
	expect(lines[ruleIndex]).toStartWith(colors.assistant.fg)
	expect(clean[secondIndex]).toContain('Hal (synthetic)')
})


test('idle session renders a stale stream like completed text', () => {
	colors.load()
	const stale: string[] = []
	renderHistory.renderLines(stale, tab([
		{ type: 'assistant', text: 'partial response', streaming: true },
		{ type: 'info', text: 'Server restarted' },
	]), 20, context())
	const completed: string[] = []
	renderHistory.renderLines(completed, tab([
		{ type: 'assistant', text: 'partial response' },
		{ type: 'info', text: 'Server restarted' },
	]), 20, context())

	expect(stale).toEqual(completed)
	expect(stale.map(stripAnsi).join('\n').match(/█/g)).toHaveLength(1)
})


test('working session renders a cursor only on the current streaming block', () => {
	colors.load()
	const lines: string[] = []
	const active = context()
	active.workingSessions = new Map([['test', true]])
	renderHistory.renderLines(lines, tab([
		{ type: 'assistant', text: 'orphaned response', streaming: true },
		{ type: 'info', text: 'intervening event' },
		{ type: 'assistant', text: 'current response', streaming: true },
	]), 20, active)

	expect(lines.map(stripAnsi).join('\n').match(/█/g)).toHaveLength(1)
})


test('session labels refresh when tab metadata changes', () => {
	const history = [{ type: 'user', text: 'hello', source: '110-gmt' }] as Tab['history']
	const first = { ...context(), sessionLabel: () => '110-gmt (Architecture revamp, tab 3)' }
	const lines: string[] = []

	renderHistory.renderLines(lines, tab(history), 80, first)
	expect(lines.map(stripAnsi).join('\n')).toContain('110-gmt (Architecture revamp, tab 3)')

	const updated = { ...first, sessionLabel: () => '110-gmt (Architecture revamp, tab 2)', sessionLabelVersion: 1 }
	const refreshed: string[] = []
	renderHistory.renderLines(refreshed, tab(history), 80, updated)
	expect(refreshed.map(stripAnsi).join('\n')).toContain('110-gmt (Architecture revamp, tab 2)')
})


test('parallel tools expand only through the first running call', () => {
	colors.load()
	const active = context()
	active.workingSessions = new Map([['test', true]])
	const t = tab([
		{ type: 'tool', name: 'bash', input: { command: 'first' }, output: 'FIRST OUTPUT', running: true, ts: 1 },
		{ type: 'tool', name: 'bash', input: { command: 'second' }, output: 'SECOND OUTPUT', running: true, ts: 1 },
	])
	const first: string[] = []
	renderHistory.renderLines(first, t, 80, active)
	expect(first.map(stripAnsi).join('\n')).toContain('FIRST OUTPUT')
	expect(first.map(stripAnsi).join('\n')).not.toContain('SECOND OUTPUT')

	;(t.history[0] as any).running = false
	t.historyVersion++
	const second: string[] = []
	renderHistory.renderLines(second, t, 80, active)
	expect(second.map(stripAnsi).join('\n')).toContain('SECOND OUTPUT')
})


test('parallel tool cards are revealed 100ms apart without delaying execution', () => {
	colors.load()
	const originalNow = Date.now
	const active = context()
	active.workingSessions = new Map([['test', true]])
	const t = tab([
		{ type: 'tool', name: 'bash', input: { command: 'first' }, running: true, ts: 1000 },
		{ type: 'tool', name: 'grep', input: { pattern: 'second', path: '.' }, running: true, ts: 1000 },
	])
	try {
		Date.now = () => 1000
		const first: string[] = []
		renderHistory.renderLines(first, t, 80, active)
		expect(first.map(stripAnsi).join('\n')).toContain('Bash: first')
		expect(first.map(stripAnsi).join('\n')).not.toContain('Grep "second"')

		Date.now = () => 1100
		renderHistory.advanceToolReveal()
		const second: string[] = []
		renderHistory.renderLines(second, t, 80, active)
		expect(second.map(stripAnsi).join('\n')).toContain('Grep "second"')
	} finally {
		Date.now = originalNow
	}
})
test('unchanged history is not re-derived on every draw', () => {
	colors.load()
	const ctx = context()
	const t = tab([
		{ type: 'user', text: 'hello' },
		{ type: 'assistant', text: 'hi there' },
	])

	const first: string[] = []
	renderHistory.renderLines(first, t, 40, ctx)

	// A second draw with untouched history must reuse the assembled lines instead of
	// regrouping and re-rendering every block, which dominated paint cost.
	let rendered = 0
	const origRenderBlock = blocks.renderBlock
	blocks.renderBlock = ((...args: Parameters<typeof origRenderBlock>) => {
		rendered++
		return origRenderBlock(...args)
	}) as typeof origRenderBlock
	const second: string[] = []
	try {
		renderHistory.renderLines(second, t, 40, ctx)
	} finally {
		blocks.renderBlock = origRenderBlock
	}

	expect(second).toEqual(first)
	expect(rendered).toBe(0)
})


test('active question renders controls with explicit cursor metadata and no HAL cursor', () => {
	colors.load()
	const lines: string[] = []
	const result = renderHistory.renderLines(lines, tab([
		{ type: 'question', id: 'q1', text: 'Proceed?', input: { kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }, source: { type: 'intro' }, active: true },
	] as any), 40, context()) as any
	const clean = lines.map(stripAnsi).join('\n')

	expect(clean).toContain('Proceed?')
	expect(clean).toContain('1. No')
	expect(clean).not.toContain('█')
	expect(result.cursor).toEqual(expect.objectContaining({ row: expect.any(Number), col: expect.any(Number) }))
})

test('answered question is compact and displays its answer', () => {
	colors.load()
	const lines: string[] = []
	renderHistory.renderLines(lines, tab([
		{ type: 'question', id: 'q1', text: 'Proceed?', input: { kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }, source: { type: 'intro' }, active: false, answer: { kind: 'choice', choiceId: 'no' } },
	] as any), 40, context())
	const nonempty = lines.map(stripAnsi).filter(Boolean)

	expect(nonempty.some((line) => line.includes('No'))).toBe(true)
	expect(nonempty.some((line) => line.includes('Proceed?'))).toBe(true)
	expect(nonempty.length).toBeLessThanOrEqual(2)
})
