import { beforeEach, describe, expect, test } from 'bun:test'
import { render } from '../src/client/terminal/render.ts'
import { client } from '../src/client/app.ts'
import { prompt } from '../src/client/terminal/prompt.ts'
import { popup } from '../src/client/terminal/popup.ts'

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

function terminalLines(output: string, rows: number, state = { screen: Array<string>(rows).fill(''), scrollback: [] as string[], row: 0, col: 0 }): typeof state {
	for (let i = 0; i < output.length; i++) {
		if (output[i] === '\x1b' && output[i + 1] === '[') {
			let end = i + 2
			while (end < output.length && !/[A-Za-z]/.test(output[end]!)) end++
			const arg = output.slice(i + 2, end)
			const amount = Number.parseInt(arg, 10) || 1
			const command = output[end]
			if (command === 'A') state.row = Math.max(0, state.row - amount)
			if (command === 'B') state.row = Math.min(rows - 1, state.row + amount)
			if (command === 'G') state.col = amount - 1
			if (command === 'H') state.row = state.col = 0
			if (command === 'K' && arg === '2') state.screen[state.row] = ''
			if (command === 'J' && (arg === '2' || arg === '')) state.screen.fill('')
			if (command === 'J' && arg === '3') state.scrollback.length = 0
			i = end
			continue
		}
		if (output[i] === '\r') state.col = 0
		else if (output[i] === '\n' && state.row === rows - 1) {
			state.scrollback.push(state.screen.shift()!)
			state.screen.push('')
		} else if (output[i] === '\n') state.row++
		else {
			const line = state.screen[state.row]!
			state.screen[state.row] = line.slice(0, state.col) + output[i] + line.slice(state.col + 1)
			state.col++
		}
	}
	return state
}

function physicalLines(state: ReturnType<typeof terminalLines>): string[] {
	return [...state.scrollback, ...state.screen]
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
	popup.close()
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

	test('keeps the physical buffer canonical when changed growth exceeds the viewport', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 10, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })
		try {
			tab.history.push({ type: 'assistant', text: 'live marker', streaming: true })
			const state = terminalLines(captureOutput(() => render.draw()), 10)

			;(tab.history[0] as any).streaming = false
			tab.history.push({ type: 'tool', name: 'bash', input: { command: 'test' }, output: Array(100).fill('output line').join('\n') })
			terminalLines(captureOutput(() => render.draw()), 10, state)

			render.resetRenderer()
			const canonical = terminalLines(captureOutput(() => render.draw(true)), 10)

			expect(physicalLines(state)).toEqual(physicalLines(canonical))
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('anchors changed fullscreen growth to the physical viewport', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 10, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })
		try {
			for (let i = 0; i < 20; i++) tab.history.push({ type: 'log', text: `old-${i}` })
			tab.history.push({ type: 'thinking', text: 'first\n\nsecond\n\nthird', streaming: true })
			const state = terminalLines(captureOutput(() => render.draw()), 10)

			// A delayed autowrap or another terminal-side cursor adjustment can move the
			// physical cursor without changing the renderer's logical cursorRow.
			state.row = Math.min(9, state.row + 1)
			tab.history[tab.history.length - 1] = { type: 'thinking', text: 'first\n\nsecond\n\nthird\n\nfourth', streaming: true }
			terminalLines(captureOutput(() => render.draw()), 10, state)

			render.resetRenderer()
			const canonical = terminalLines(captureOutput(() => render.draw(true)), 10)
			expect(physicalLines(state)).toEqual(physicalLines(canonical))
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('keeps cursor coordinates valid after a fullscreen prompt shrink', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
		try {
			for (let i = 0; i < 20; i++) tab.history.push({ type: 'log', text: `old-${i}` })
			prompt.setText('one line\nanother line')
			const state = terminalLines(captureOutput(() => render.draw()), 8)

			prompt.setText('one line')
			terminalLines(captureOutput(() => render.draw()), 8, state)
			prompt.setText('one line!')
			terminalLines(captureOutput(() => render.draw()), 8, state)

			render.resetRenderer()
			const canonical = terminalLines(captureOutput(() => render.draw(true)), 8)
			expect(state.screen).toEqual(canonical.screen)
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

})
