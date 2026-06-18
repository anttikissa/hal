import { expect, test } from 'bun:test'
import { colors } from '../cli/colors.ts'
import { renderHistory, type HistoryRenderContext } from './render-history.ts'
import type { Tab } from '../client.ts'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
}

function context(): HistoryRenderContext {
	return {
		forkHistoryDimFactor: 0.5,
		blockCache: new WeakMap(),
		cursorVisible: false,
		workingSessions: new Map(),
		cursorFadeMs: 0,
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
	const ruleIndex = firstIndex + 1
	const secondIndex = ruleIndex + 1

	expect(firstIndex).toBeGreaterThanOrEqual(0)
	expect(clean[ruleIndex]).toBe('─'.repeat(20))
	expect(lines[ruleIndex]).toStartWith(colors.assistant.fg)
	expect(clean[secondIndex]).toContain('Hal (synthetic)')
})
