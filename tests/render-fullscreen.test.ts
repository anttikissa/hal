import { beforeEach, describe, expect, test } from 'bun:test'
import { render } from '../src/client/render.ts'
import { client } from '../src/client.ts'
import { prompt } from '../src/cli/prompt.ts'

function captureOutput(fn: () => void): string {
	const writes: string[] = []
	const originalWrite = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (chunk: any) => {
		writes.push(String(chunk))
		return true
	}
	try { fn() }
	finally { (process.stdout as any).write = originalWrite }
	return writes.join('')
}

beforeEach(() => {
	render.resetRenderer()
	client.state.tabs.length = 0
	client.state.tabs.push({
		sessionId: 'test',
		name: 'tab 1',
		history: [],
		inputHistory: [],
		loaded: true,
		inputDraft: '',
		doneUnseen: false, parentEntryCount: 0,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '/tmp',
		model: 'test',
	})
	client.state.focusedTabIndex = 0
	client.state.pid = 111
	client.state.hostPid = 222
	client.state.peak = 0
	client.state.peakCols = 0
	client.state.working = new Map()
	prompt.clear()
})

describe('render fullscreen growth', () => {
	test('rewrites visible rows without clearing scrollback when growth changes existing rows', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
		try {
			tab.history.push({ type: 'info', text: 'one' })
			tab.history.push({ type: 'info', text: 'two' })
			captureOutput(() => render.draw())

			tab.history.unshift({ type: 'info', text: 'zero' })
			tab.historyVersion++
			const output = captureOutput(() => render.draw())
			expect(output).not.toContain('\x1b[3J')
			expect(output).not.toContain('\x1b[2J\x1b[H')
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('advances the viewport before repainting changed rows in a growing fullscreen frame', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })
		try {
			tab.history.push({ type: 'assistant', text: 'old text', streaming: true })
			captureOutput(() => render.draw())

			;(tab.history[0] as any).streaming = false
			tab.history.push({ type: 'tool', name: 'read', input: { path: 'a' } })
			const output = captureOutput(() => render.draw())

			// Advance the newly-needed rows at the old frame bottom first, then paint
			// the new viewport; otherwise rewriting the longer tail scrolls stale
			// copies of the changed assistant block into terminal scrollback.
			expect(output).toMatch(/\x1b\[\d+B(?:\r\n)+\x1b\[\d+A\r/)
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})
})
