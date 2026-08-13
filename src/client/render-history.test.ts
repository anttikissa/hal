import { expect, test } from 'bun:test'
import { colors } from './terminal/colors.ts'
import { renderHistory, type HistoryRenderContext } from './render-history.ts'
import type { Tab } from './app.ts'

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
