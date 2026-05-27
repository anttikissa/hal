import { describe, test, expect, beforeEach } from 'bun:test'
import { render } from '../src/client/render.ts'
import { renderStatus } from '../src/client/render-status.ts'
import { client } from '../src/client.ts'
import { prompt } from '../src/cli/prompt.ts'
import { cursor } from '../src/cli/cursor.ts'
import { popup } from '../src/client/popup.ts'
import { openaiUsage } from '../src/openai-usage.ts'
import { colors } from '../src/cli/colors.ts'
import { version } from '../src/version.ts'

openaiUsage.init()
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
	client.state.tabs.push({ sessionId: 'test', name: 'tab 1', history: [], inputHistory: [], loaded: true, inputDraft: '', doneUnseen: false, parentEntryCount: 0, historyVersion: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextUsed: 0, contextMax: 0, cwd: '/tmp', model: 'test' })
	client.state.activeTab = 0
	client.state.pid = 111
	client.state.hostPid = 222
	client.state.peak = 0
	client.state.peakCols = 0
	client.state.busy = new Map()
	client.state.activity = new Map()
	client.state.toolConfirmPending = new Set()
	prompt.clear()
	prompt.config.maxPromptLines = 10
	prompt.state.promptLineLimit = 0
	popup.close()
	Object.assign(renderStatus.config, {
		showSession: true,
		showCwd: true,
		showModel: true,
		showContext: true,
		showServer: true,
		showTokenInOut: true,
		showTokenCache: false,
		showSubscription: true,
	})
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
	version.resetForTests()

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
		tab.history.push({ type: 'log', text: 'hello' })
		tab.history.push({ type: 'log', text: 'world' })
		captureOutput(() => render.draw())
		const output = captureOutput(() => render.draw(true))
		const clean = stripAnsi(output)
		expect(clean).toContain('hello')
		expect(clean).toContain('world')
	})

	test('consecutive info blocks in the same minute collapse into one rendered block', () => {
		const tab = client.currentTab()!
		const ts = Date.now()
		tab.history.push({ type: 'log', text: '31.0ms First line of code executed', ts })
		tab.history.push({ type: 'log', text: '31.0ms State directories exist', ts: ts + 1000 })
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('31.0ms First line of code executed')
		expect(clean).toContain('31.0ms State directories exist')
		expect(clean.match(/Log/g)?.length ?? 0).toBe(1)
	})

	test('consecutive info blocks across days collapse with a date range header', () => {
		const originalNow = Date.now
		Date.now = () => new Date(2026, 4, 6, 13, 0).getTime()
		try {
			const tab = client.currentTab()!
			tab.history.push({ type: 'log', text: 'first metadata refresh', ts: new Date(2026, 4, 4, 19, 30).getTime() })
			tab.history.push({ type: 'log', text: 'second metadata refresh', ts: new Date(2026, 4, 6, 12, 10).getTime() })
			const clean = stripAnsi(captureOutput(() => render.draw(true)))
			expect(clean).toContain('4 May 19:30 - 6 May 12:10 Log')
			expect(clean).toContain('first metadata refresh')
			expect(clean).toContain('second metadata refresh')
			expect(clean.match(/Log/g)?.length ?? 0).toBe(1)
		} finally {
			Date.now = originalNow
		}
	})

	test('old block timestamps include date', () => {
		const originalNow = Date.now
		Date.now = () => new Date(2026, 4, 6, 13, 0).getTime()
		try {
			const tab = client.currentTab()!
			tab.history.push({ type: 'assistant', text: 'old answer', ts: new Date(2026, 4, 4, 19, 30).getTime() })
			const clean = stripAnsi(captureOutput(() => render.draw(true)))
			expect(clean).toContain('4 May 19:30 Hal')
		} finally {
			Date.now = originalNow
		}
	})

	test('multiline info blocks do not get flattened into a coalesced info group', () => {
		const tab = client.currentTab()!
		const ts = Date.now()
		tab.history.push({ type: 'log', text: 'Ready', ts })
		tab.history.push({
			type: 'log',
			text: 'Current config:\n{\n\tprompt: {\n\t\tmaxPromptLines: 10,\n\t},\n}',
			ts: ts + 1000,
		})
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('Ready')
		expect(clean).toContain('Current config:')
		expect(clean).not.toContain('[Current config:]')
		expect(clean.match(/Log/g)?.length ?? 0).toBe(2)
	})

	test('paused info before a steering prompt is hidden', () => {
		const tab = client.currentTab()!
		const ts = Date.now()
		tab.history.push({ type: 'log', text: '[paused]', ts })
		tab.history.push({ type: 'user', text: 'Esc does not exit it. What does?', status: 'steering', ts: ts + 1000 })
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).not.toContain('[paused]')
		expect(clean).toContain('You (steering)')
		expect(clean).toContain('Esc does not exit it. What does?')
	})

	test('paused info before queued prompt notice is hidden and notice markdown renders', () => {
		const tab = client.currentTab()!
		const ts = Date.now()
		tab.history.push({ type: 'log', text: '[paused]', ts })
		tab.history.push({ type: 'info', text: 'Paused. 1 queued prompt is waiting. Next: **foo**. **ctrl-q** to run the queued prompt, `/queue clear` to discard it.', ts: ts + 1000 })
		const raw = captureOutput(() => render.draw(true))
		const clean = stripAnsi(raw)
		expect(clean).not.toContain('[paused]')
		expect(clean).toContain('Info')
		expect(clean).toContain('Next: foo')
		expect(clean).not.toContain('**foo**')
		expect(clean).not.toContain('**ctrl-q**')
		expect(clean).not.toContain('`/queue clear`')
	})

	test('paused info still renders when there is no steering prompt after it', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'log', text: '[paused]', ts: Date.now() })
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('[paused]')
	})

	test('help bar says enter continue on paused tabs with empty prompt', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'log', text: '[paused]', ts: Date.now() })
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('enter: continue')
		expect(clean).not.toContain('press enter to continue')
		expect(clean).not.toContain('ctrl-t new')
	})

	test('help bar says press enter to retry after errors', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'error', text: 'timed out after 60000ms', ts: Date.now() })
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('press enter to retry')
		expect(clean).not.toContain('press enter to continue')
	})

	test('help bar hides retry once retry is in progress', () => {
		// Reproduces the bug where the help bar kept showing retry while a retry
		// was already running new tool calls.
		const tab = client.currentTab()!
		tab.history.push({ type: 'error', text: 'timed out after 60000ms', ts: Date.now() })
		tab.history.push({ type: 'tool', toolId: 't1', name: 'read', input: {}, ts: Date.now() })
		client.state.busy.set(tab.sessionId, true)
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).not.toContain('press enter to retry')
		client.state.busy.clear()
	})

	test('help bar says enter continue after max iteration stop', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'error', text: 'Hit max iterations (50). Stopping.', ts: Date.now() })
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('enter: continue')
		expect(clean).not.toContain('press enter to retry')
	})

	test('continue hint matches enter behavior for whitespace-only prompts', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'log', text: '[paused]', ts: Date.now() })
		prompt.setText('   ')
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('enter: continue')
	})

	test('help bar renders keys brighter than descriptions but not bright white', () => {
		prompt.setText('hello')
		const output = captureOutput(() => render.draw(true))
		expect(output).not.toContain('\x1b[97menter')
		expect(output).toContain('enter')
		expect(output).toContain(': send')
		expect(output).toContain('shift-enter')
		expect(output).toContain(': newline')
		expect(output).toContain('alt-enter')
		expect(output).toContain(': queue')
	})

	test('help bar advertises queue and the /keys shortcut list', () => {
		prompt.setText('hello')
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('alt-enter: queue')
		expect(clean).toContain('/keys: shortcuts')
	})

	test('help bar has one-cell padding on both sides', () => {
		prompt.setText('hello')
		const lines = stripAnsi(captureOutput(() => render.draw(true))).split('\n')
		const helpLine = lines.find((line) => line.includes('enter: send')) ?? ''
		expect(helpLine.startsWith(' ')).toBe(true)
		expect(helpLine.endsWith(' ')).toBe(true)
		expect(helpLine.length).toBe(process.stdout.columns || 80)
	})

	test('help bar separates hints with commas', () => {
		prompt.setText('hello')
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('enter: send, shift-enter: newline, alt-enter: queue')
		expect(clean).not.toContain('│')
	})

	test('help bar suggests resizing two lines before prompt scrolling', () => {
		prompt.config.maxPromptLines = 5
		prompt.setText('one\ntwo\nthree')
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		expect(clean).toContain('ctrl+=/-: resize editor')
	})

	test('chrome order is tabs, prompt box, status, then help at the bottom', () => {
		prompt.setText('hello')
		const lines = stripAnsi(captureOutput(() => render.draw(true))).split('\n')
		const promptLine = lines.findIndex((line) => line.trim() === 'hello')
		const statusLine = lines.findIndex((line) => line.includes('server'))
		const helpLine = lines.findIndex((line) => line.includes('enter: send'))
		expect(promptLine).toBeGreaterThanOrEqual(0)
		expect(statusLine).toBe(promptLine + 2)
		expect(helpLine).toBe(statusLine + 1)
		expect(lines[lines.length - 1]).toContain('enter: send')
	})

	test('status line shows host role without pid', () => {
		const clean = stripAnsi(captureOutput(() => render.draw()))
		expect(clean).toContain('server')
		expect(clean).not.toContain('server:111')
		expect(clean).not.toContain('lock:')
	})

	test('status line shows session id before human name', () => {
		client.currentTab()!.name = 'Pause Fix'
		const clean = stripAnsi(captureOutput(() => render.draw()))
		expect(clean).toContain('test: Pause Fix')
	})

	test('client status line shows a host mismatch badge on the right', () => {
		client.state.role = 'client'
		client.state.pid = 111
		client.state.hostPid = 222
		client.state.hostVersionStatus = 'ready'
		client.state.hostVersion = 'host5678'
		version.state.status = 'ready'
		version.state.combined = 'local1234'
		const clean = stripAnsi(captureOutput(() => render.draw()))
		expect(clean).toContain('client ≠host')
	})

	test('status line shows model, context, token arrows, and grouped subscription usage', () => {
		const tab = client.currentTab()!
		tab.model = 'openai/gpt-5.4'
		tab.contextUsed = 39_000
		tab.contextMax = 1_050_000
		tab.usage = { input: 600_000, output: 1_100_000, cacheRead: 0, cacheCreation: 0 }
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true })
		try {
			const clean = stripAnsi(captureOutput(() => render.draw()))
			expect(clean).toContain('test · /tmp · GPT 5.4')
			expect(clean).toContain('/tmp')
			expect(clean).toContain('GPT 5.4')
			expect(clean).toContain('39k/1050k (4%)')
			expect(clean).toContain('↑600k ↓1.1M')
			expect(clean).toContain('Sub 2/3: 5h 23%, 7d 61%')
		} finally {
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('status line formats usage like pi-mono', () => {
		const tab = client.currentTab()!
		tab.model = 'openai/gpt-5.4'
		tab.contextUsed = 39_000
		tab.contextMax = 1_050_000
		tab.usage = { input: 378, output: 2_200, cacheRead: 42_000, cacheCreation: 1_000 }
		renderStatus.config.showTokenCache = true
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true })
		try {
			const clean = stripAnsi(captureOutput(() => render.draw()))
			expect(clean).toContain('↑378 ↓2.2k R42k W1.0k')
			expect(clean).not.toContain('↑43k')
			expect(clean).not.toContain('tokens CR:')
		} finally {
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('status line visibility flags hide configured parts', () => {
		const tab = client.currentTab()!
		tab.model = 'openai/gpt-5.4'
		tab.contextUsed = 39_000
		tab.contextMax = 1_050_000
		tab.usage = { input: 56_000, output: 2_800, cacheRead: 1_700_000, cacheCreation: 42_000 }
		Object.assign(renderStatus.config, {
			showSession: false,
			showCwd: false,
			showModel: false,
			showContext: false,
			showServer: false,
			showTokenInOut: false,
			showTokenCache: true,
			showSubscription: false,
		})
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true })
		try {
			const clean = stripAnsi(captureOutput(() => render.draw()))
			expect(clean).not.toContain('test')
			expect(clean).not.toContain('/tmp')
			expect(clean).not.toContain('GPT 5.4')
			expect(clean).not.toContain('39k/1050k (4%)')
			expect(clean).not.toContain('server')
			expect(clean).not.toContain('↑56k ↓2.8k')
			expect(clean).not.toContain('Sub 2/3')
			expect(clean).toContain('R1.7M W42k')
		} finally {
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('status line drops right-side fields in the requested order', () => {
		const tab = client.currentTab()!
		tab.model = 'openai/gpt-5.4'
		tab.contextUsed = 39_000
		tab.contextMax = 1_050_000
		tab.usage = { input: 600_000, output: 1_100_000, cacheRead: 0, cacheCreation: 0 }
		client.state.role = 'client'
		client.state.pid = 111
		client.state.hostPid = 222
		client.state.hostVersionStatus = 'ready'
		client.state.hostVersion = 'host5678'
		version.state.status = 'ready'
		version.state.combined = 'local1234'
		const originalCols = process.stdout.columns
		try {
			Object.defineProperty(process.stdout, 'columns', { value: 86, configurable: true })
			let clean = stripAnsi(captureOutput(() => render.draw()))
			expect(clean).toContain('client ≠host')
			expect(clean).toContain('↑600k ↓1.1M')
			expect(clean).not.toContain('Sub 2/3: 5h 23%, 7d 61%')

			Object.defineProperty(process.stdout, 'columns', { value: 74, configurable: true })
			clean = stripAnsi(captureOutput(() => render.draw()))
			expect(clean).toContain('client ≠host')
			expect(clean).toContain('↑600k ↓1.1M')
			expect(clean).not.toContain('Sub 2/3: 5h 23%, 7d 61%')

			Object.defineProperty(process.stdout, 'columns', { value: 58, configurable: true })
			clean = stripAnsi(captureOutput(() => render.draw()))
			expect(clean).toContain('client ≠host')
			expect(clean).not.toContain('↑600k ↓1.1M')
			expect(clean).not.toContain('Sub 2/3: 5h 23%, 7d 61%')
		} finally {
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('busy tab minicursor pulses with OKLCH-dimmed color', () => {
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
			usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
			contextUsed: 0,
			contextMax: 0,
			cwd: '/tmp',
			model: 'test',
		})
		client.state.busy.set('other', true)
		const originalIsVisible = cursor.isVisible
		const originalCursor = colors.input.cursor
		const originalCursorDim = colors.input.cursorDim
		colors.input.cursor = '\x1b[38;2;92;179;255m'
		colors.input.cursorDim = '\x1b[38;2;36;96;159m'
		try {
			cursor.isVisible = () => true
			render.resetRenderer()
			const bright = captureOutput(() => render.draw(true))

			cursor.isVisible = () => false
			render.resetRenderer()
			const dimmed = captureOutput(() => render.draw(true))
			const clean = stripAnsi(dimmed)
			const tabBar = clean.split('\n').find((line) => line.includes('2▪'))
			expect(tabBar).toBeDefined()
			expect(tabBar).toContain('2▪')
			expect(dimmed).not.toContain('\x1b[2m')
			expect(dimmed).not.toContain(renderStatus.halCursorColor())
			expect(dimmed).not.toBe(bright)
			expect(render.hasAnimatedIndicators()).toBe(true)
			expect(dimmed).toContain(`${colors.input.cursorDim}▪`)
		} finally {
			cursor.isVisible = originalIsVisible
			colors.input.cursor = originalCursor
			colors.input.cursorDim = originalCursorDim
		}
	})

	test('tab bar shows ctrl-t only when there is one tab', () => {
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		const tabLine = clean.split('\n').find((line) => line.includes('Tabs:')) ?? ''
		expect(tabLine).toContain(' Tabs: ◣1◢')
		expect(tabLine).toContain('ctrl-t: new')
		expect(tabLine).toContain('ctrl-f: fork')
		expect(tabLine).not.toContain('alt-#: goto')
		expect(tabLine).not.toContain('ctrl-n/p: switch')
	})

	test('active tab uses truecolor black pocket without bright palette ANSI', () => {
		const label = renderStatus.tabLabel(client.state.tabs[0]!, 0)
		expect(label).toContain('\x1b[48;2;0;0;0m')
		expect(label).not.toContain('\x1b[40m')
		expect(label).not.toContain('\x1b[97m')
	})

	test('tab bar shows navigation hints instead of ctrl-t with multiple tabs', () => {
		client.state.tabs.push({
			sessionId: 's2',
			name: 'beta',
			history: [],
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
		})

		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		const tabLine = clean.split('\n').find((line) => line.includes('Tabs:')) ?? ''
		expect(tabLine).toContain(' Tabs: ◣1◢2 ')
		expect(tabLine).toContain('alt-#: goto')
		expect(tabLine).toContain('ctrl-n/p: switch')
		expect(tabLine).toContain('ctrl-w: close')
		expect(tabLine).not.toContain('ctrl-t: new')
		expect(tabLine).not.toContain('beta')
		expect(stripAnsi(renderStatus.tabLabel(client.state.tabs[0]!, 0))).toBe('◣1◢')
		expect(stripAnsi(renderStatus.tabLabel(client.state.tabs[1]!, 1))).toBe('2')
	})

	test('tab bar keeps two-digit tabs compact with inline indicators', () => {
		for (let i = 2; i <= 24; i++) {
			client.state.tabs.push({
				sessionId: `s${i}`,
				name: `tab ${i}`,
				history: [],
				inputHistory: [],
				loaded: true,
				inputDraft: '',
				doneUnseen: i === 2,
				parentEntryCount: 0,
				historyVersion: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
				contextUsed: 0,
				contextMax: 0,
				cwd: '/tmp',
				model: 'test',
			})
		}
		client.state.activeTab = 23

		const originalCols = process.stdout.columns
		try {
			Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true })
			const clean = stripAnsi(captureOutput(() => render.draw(true)))
			const tabLine = clean.split('\n').find((line) => line.includes('◣24◢')) ?? ''
			expect(tabLine).toContain('1 2✓')
			expect(tabLine).toContain('23 ◣24◢')
			expect(tabLine).not.toContain('[24✓]')
			expect(stripAnsi(renderStatus.tabLabel(client.state.tabs[1]!, 1))).toBe('2✓')
			expect(stripAnsi(renderStatus.tabLabel(client.state.tabs[23]!, 23))).toBe('◣24◢')
		} finally {
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('busy tab minicursor uses the main HAL cursor color', () => {
		const tab = client.currentTab()!
		client.state.busy.set(tab.sessionId, true)

		const originalCursor = colors.input.cursor
		const originalIsVisible = cursor.isVisible
		colors.input.cursor = '\x1b[38;5;201m'
		cursor.isVisible = () => true
		try {
			const output = captureOutput(() => render.draw())
			expect(output).toContain(`${colors.input.cursor}▪`)
			expect(output).not.toContain('\x1b[38;5;75m▪')
		} finally {
			colors.input.cursor = originalCursor
			cursor.isVisible = originalIsVisible
		}
	})

	test('pending risky tool confirmation shows a yellow alert instead of busy minicursor', () => {
		const tab = client.currentTab()!
		client.state.busy.set(tab.sessionId, true)

		client.handleEvent({
			type: 'tool-confirm-request',
			sessionId: tab.sessionId,
			requestId: 'risk-1',
			body: ['risky'],
			createdAt: new Date(0).toISOString(),
		})

		const output = captureOutput(() => render.draw())
		const clean = stripAnsi(output)
		const tabBar = clean.split('\n').find((line) => line.includes('◣1!◢'))
		expect(tabBar).toBeDefined()
		expect(tabBar).toContain('◣1!◢')
		expect(tabBar).not.toContain('◣1▪◢')
		expect(output).toContain('\x1b[33m!')
	})

	test('idle HAL cursor reserves three rows above the tab bar', () => {
		const originalIsVisible = cursor.isVisible
		cursor.isVisible = () => true
		try {
			const lines = stripAnsi(captureOutput(() => render.draw(true))).split('\n')
			const tabBar = lines.findIndex((line) => line.includes('◣1◢'))
			expect(tabBar).toBeGreaterThanOrEqual(3)
			expect(lines[tabBar - 3]).toBe('')
			expect(lines[tabBar - 2]).toBe('█')
			expect(lines[tabBar - 1]).toBe('')
		} finally {
			cursor.isVisible = originalIsVisible
		}
	})

	test('streaming assistant and thinking blocks show a solid HAL cursor inline', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'assistant', text: 'hello', streaming: true })
		tab.history.push({ type: 'thinking', text: 'hmm', streaming: true })

		const originalIsVisible = cursor.isVisible
		try {
			cursor.isVisible = () => true
			render.resetRenderer()
			const visiblePhase = stripAnsi(captureOutput(() => render.draw(true)))
			expect(visiblePhase).toContain('hmm█')

			cursor.isVisible = () => false
			render.resetRenderer()
			const hiddenPhase = stripAnsi(captureOutput(() => render.draw(true)))
			expect(hiddenPhase).toContain('hmm█')
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
			usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
			contextUsed: 0,
			contextMax: 0,
			cwd: '/tmp',
			model: 'test',
		})
		client.state.busy.set('other', true)
		client.state.activity.set('other', 'generating...')
		client.handleEvent({
			type: 'info',
			sessionId: 'other',
			text: 'Hit max iterations (50). Stopping.',
			level: 'error',
			createdAt: new Date(0).toISOString(),
		})
		client.state.busy.delete('other')
		client.state.activity.delete('other')

		expect(client.state.tabs[1]?.history[0]).toMatchObject({
			type: 'error',
			text: 'Hit max iterations (50). Stopping.',
		})

		const originalIsVisible = cursor.isVisible
		cursor.isVisible = () => true
		try {
			const clean = stripAnsi(captureOutput(() => render.draw()))
			const tabBar = clean.split('\n').find((line) => line.includes('2✗'))
			expect(tabBar).toBeDefined()
			expect(tabBar).toContain('2✗')
			expect(tabBar).not.toContain('2✓')
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

	test('text hints still reserve the help-bar row', () => {
		render.resetRenderer()
		const empty = stripAnsi(captureOutput(() => render.draw(true))).split('\n')

		render.resetRenderer()
		prompt.setText('x')
		const withText = stripAnsi(captureOutput(() => render.draw(true))).split('\n')

		const emptyHelp = empty.find((line) => line.includes('type a prompt'))
		const promptLine = withText.findIndex((line) => line.trim() === 'x')
		expect(emptyHelp).toContain('type a prompt')
		expect(promptLine).toBeGreaterThan(0)
		expect(withText[promptLine + 3]).toContain('/keys: shortcuts')
		expect(withText.length).toBe(empty.length)
	})

	test('fullscreen growth with non-append changes does not clear scrollback', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
		try {
			tab.history.push({ type: 'log', text: 'one' })
			tab.history.push({ type: 'log', text: 'two' })
			captureOutput(() => render.draw())

			tab.history.unshift({ type: 'log', text: 'zero' })
			tab.historyVersion++
			const output = captureOutput(() => render.draw())
			expect(output).not.toContain('\x1b[3J')
			expect(output).not.toContain('\x1b[2J\x1b[H')
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('fullscreen ignores changes entirely above the live viewport', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
		try {
			for (let i = 0; i < 12; i++) {
				tab.history.push({ type: 'assistant', text: `line ${i}`, ts: i })
			}
			captureOutput(() => render.draw())
			captureOutput(() => render.draw())

			;(tab.history[0] as any).text = 'changed offscreen'
			tab.historyVersion++
			const output = captureOutput(() => render.draw())
			expect(output).toBe('')
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('fullscreen shrink repaints without clearing scrollback', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
		try {
			for (let i = 0; i < 20; i++) tab.history.push({ type: 'log', text: `old-${i}` })
			captureOutput(() => render.draw())

			tab.history.splice(0, tab.history.length, { type: 'log', text: 'new' })
			tab.historyVersion++
			const output = captureOutput(() => render.draw())
			expect(output).toContain('\x1b[2J\x1b[H')
			expect(output).not.toContain('\x1b[3J')
			expect(stripAnsi(output)).toContain('new')
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
			Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
		}
	})

	test('fullscreen prompt shrink repaints so the viewport stays bottom anchored', () => {
		const tab = client.currentTab()!
		const originalRows = process.stdout.rows
		const originalCols = process.stdout.columns
		Object.defineProperty(process.stdout, 'rows', { value: 8, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
		try {
			for (let i = 0; i < 20; i++) tab.history.push({ type: 'log', text: `old-${i}` })
			prompt.setText('one line\nanother line')
			captureOutput(() => render.draw())

			prompt.setText('one line')
			const output = captureOutput(() => render.draw())

			expect(output).toContain('\x1b[2J\x1b[H')
			expect(output).not.toContain('\x1b[3J')
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
			for (let i = 0; i < 12; i++) tab.history.push({ type: 'log', text: `line ${i}` })
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
