import { describe, test, expect, beforeEach } from 'bun:test'
import { render } from '../src/client/render.ts'
import { client } from '../src/client.ts'
import { prompt } from '../src/cli/prompt.ts'
import { cursor } from '../src/cli/cursor.ts'
import { popup } from '../src/client/popup.ts'
import { helpBar } from '../src/cli/help-bar.ts'
import { openaiUsage } from '../src/openai-usage.ts'
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

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
	client.state.tabs.push({ sessionId: 'test', name: 'tab 1', history: [], inputHistory: [], loaded: true, inputDraft: '', doneUnseen: false, parentEntryCount: 0, historyVersion: 0, usage: { input: 0, output: 0 }, contextUsed: 0, contextMax: 0, cwd: '/tmp', model: 'test' })
	client.state.activeTab = 0
	client.state.pid = 111
	client.state.hostPid = 222
	client.state.peak = 0
	client.state.peakCols = 0
	client.state.busy = new Map()
	client.state.activity = new Map()
	prompt.clear()
	helpBar.reset()
	popup.close()
	openaiUsage.state.currentKey = 'openai:1'
	openaiUsage.state.accounts = {
		'openai:1': {
			key: 'openai:1',
			index: 1,
			total: 3,
			pendingTokens: 0,
			primary: { usedPercent: 23, windowMinutes: 300, resetAt: 1 },
			secondary: { usedPercent: 61, windowMinutes: 10080, resetAt: 1 },
		},
	}
})

describe('render', () => {
	test('diff engine only rewrites changed lines', () => {
		captureOutput(() => render.draw())
		prompt.setText('x')
		const output = captureOutput(() => render.draw())
		expect(output).not.toContain('\x1b[2J\x1b[H')
		expect(stripAnsi(output)).toContain('x')
	})

	test('force repaint in grow mode does not clear scrollback', () => {
		captureOutput(() => render.draw())
		const output = captureOutput(() => render.draw(true))
		expect(output).toContain('\x1b[J')
		expect(output).not.toContain('\x1b[3J')
	})

	test('writes ALL lines on force repaint', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'info', text: 'hello' })
		tab.history.push({ type: 'info', text: 'world' })
		captureOutput(() => render.draw())
		const output = captureOutput(() => render.draw(true))
		const clean = stripAnsi(output)
		expect(clean).toContain('hello')
		expect(clean).toContain('world')
	})

	test('consecutive info blocks in the same minute collapse into one rendered block', () => {
		const tab = client.currentTab()!
		const ts = Date.now()
		tab.history.push({ type: 'info', text: '31.0ms First line of code executed', ts })
		tab.history.push({ type: 'info', text: '31.0ms State directories exist', ts: ts + 1000 })
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('31.0ms First line of code executed')
		expect(clean).toContain('31.0ms State directories exist')
		expect(clean.match(/Info/g)?.length ?? 0).toBe(1)
	})

	test('status line shows local pid', () => {
		const clean = stripAnsi(captureOutput(() => render.draw()))
		expect(clean).toContain('server:111')
		expect(clean).not.toContain('lock:')
	})

	test('status line shows current OpenAI subscription usage', () => {
		client.currentTab()!.model = 'openai/gpt-5.4'
		const clean = stripAnsi(captureOutput(() => render.draw()))
		expect(clean).toContain('GPT 5.4 sub2/3')
		expect(clean).toContain('5h 23%')
		expect(clean).toContain('7d 61%')
	})

	test('status line shows busy account rotation activity', () => {
		client.state.busy.set('test', true)
		client.state.activity.set('test', 'OpenAI 2/3 · next@test.com')
		const clean = stripAnsi(captureOutput(() => render.draw()))
		expect(clean).toContain('OpenAI 2/3 · next@test.com')
	})

	test('busy tabs stay visible during the dim pulse phase', () => {
		client.state.tabs.push({
			sessionId: 'other',
			name: 'tab 2',
			history: [],
			inputHistory: [],
			loaded: true,
			inputDraft: '',
			doneUnseen: false,
			parentEntryCount: 0,
			historyVersion: 0,
			usage: { input: 0, output: 0 },
			contextUsed: 0,
			contextMax: 0,
			cwd: '/tmp',
			model: 'test',
		})
		client.state.busy.set('other', true)
		const originalIsVisible = cursor.isVisible
		cursor.isVisible = () => false
		try {
			const output = captureOutput(() => render.draw())
			const clean = stripAnsi(output)
			const tabBar = clean.split('\n').find((line) => line.includes('tab 2'))
			expect(tabBar).toBeDefined()
			expect(tabBar).toContain('▪tab 2')
			expect(output).toContain('\x1b[2m')
		} finally {
			cursor.isVisible = originalIsVisible
		}
	})
	test('error-level info on an inactive finished tab shows an alert indicator', () => {
		client.state.tabs.push({
			sessionId: 'other',
			name: 'tab 2',
			history: [],
			inputHistory: [],
			loaded: true,
			inputDraft: '',
			doneUnseen: false, parentEntryCount: 0,
			historyVersion: 0,
			usage: { input: 0, output: 0 },
			contextUsed: 0,
			contextMax: 0,
			cwd: '/tmp',
			model: 'test',
		})
		client.handleEvent({ type: 'status', sessionId: 'other', busy: true, activity: 'generating...' })
		client.handleEvent({
			type: 'info',
			sessionId: 'other',
			text: 'Hit max iterations (50). Stopping.',
			level: 'error',
			createdAt: new Date(0).toISOString(),
		})
		client.handleEvent({ type: 'status', sessionId: 'other', busy: false, activity: '' })

		expect(client.state.tabs[1]?.history[0]).toMatchObject({
			type: 'error',
			text: 'Hit max iterations (50). Stopping.',
		})

		const originalIsVisible = cursor.isVisible
		cursor.isVisible = () => true
		try {
			const clean = stripAnsi(captureOutput(() => render.draw()))
			const tabBar = clean.split('\n').find((line) => line.includes('tab 2'))
			expect(tabBar).toBeDefined()
			expect(tabBar).toContain('✗tab 2')
			expect(tabBar).not.toContain('✓tab 2')
		} finally {
			cursor.isVisible = originalIsVisible
		}
	})

	test('model picker popup draws over the normal frame', () => {
		popup.openModelPicker(() => {})
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('Pick a model')
		expect(clean).toContain('> ')
		expect(clean).toContain('sonnet')
	})

	test('learned idle-text hints still reserve the help-bar row', () => {
		for (let i = 0; i < helpBar.config.learnThreshold; i++) {
			helpBar.logKey('enter')
			helpBar.logKey('shift-enter')
			helpBar.logKey('tab')
		}

		render.resetRenderer()
		const empty = stripAnsi(captureOutput(() => render.draw(true))).split('\n')

		render.resetRenderer()
		prompt.setText('x')
		const withText = stripAnsi(captureOutput(() => render.draw(true))).split('\n')

		expect(empty[2]).toContain('ctrl-t new')
		expect(withText[2]).toBe('')
		expect(withText[3]).toBe('x')
		expect(withText.length).toBe(empty.length)
	})

	test('fullscreen growth with non-append changes forces repaint', () => {
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
			const output = captureOutput(() => render.draw())
			expect(output).toContain('\x1b[2J\x1b[H\x1b[3J')
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})


	test('popup overlay targets the visible viewport in fullscreen', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
		try {
			for (let i = 0; i < 12; i++) tab.history.push({ type: 'info', text: `line ${i}` })
			captureOutput(() => render.draw(true))
			popup.openModelPicker(() => {})
			const clean = stripAnsi(captureOutput(() => render.draw(true))).split('\n')
			const visible = clean.slice(-8).join('\n')
			expect(visible).toContain('Pick a model')
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})
})
