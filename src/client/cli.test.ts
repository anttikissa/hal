import { expect, test } from 'bun:test'
import { cli } from './cli.ts'
import { client } from '../client.ts'
import { ipc } from '../ipc.ts'
import { prompt } from '../cli/prompt.ts'
import { render } from './render.ts'
import { cursor } from '../cli/cursor.ts'
import { popup } from './popup.ts'

function makeRawSink(): { lines: string[]; emit: (text: string) => void } {
	const lines: string[] = []
	return { lines, emit: (text) => lines.push(text) }
}

function withPatched<T extends object, K extends keyof T>(object: T, key: K, value: T[K], run: () => void): void {
	const original = object[key]
	object[key] = value
	try { run() }
	finally { object[key] = original }
}

test('SIGWINCH forces a redraw after terminal resize', () => {
	let forceDraws = 0
	const sigwinch: Array<() => void> = []
	const on = ((event: string, listener: () => void) => {
		if (event === 'SIGWINCH') sigwinch.push(listener)
		return process
	}) as typeof process.on
	const off = ((event: string, listener: () => void) => {
		if (event === 'SIGWINCH') sigwinch.splice(sigwinch.indexOf(listener), 1)
		return process
	}) as typeof process.off
	withPatched(process, 'on', on, () => {
		withPatched(process, 'off', off, () => {
			withPatched(process.stdout, 'write', (() => true) as typeof process.stdout.write, () => {
				withPatched(process.stdin, 'on', (() => process.stdin) as typeof process.stdin.on, () => {
					withPatched(process.stdin, 'resume', (() => process.stdin) as typeof process.stdin.resume, () => {
						withPatched(render, 'draw', ((force = false) => { if (force) forceDraws++ }) as typeof render.draw, () => {
							withPatched(client, 'startClient', (() => {}) as typeof client.startClient, () => {
								withPatched(cursor, 'start', (() => {}) as typeof cursor.start, () => {
									const controller = new AbortController()
									cli.startCli(controller.signal)
									for (const listener of sigwinch) listener()
									controller.abort()
								})
							})
						})
					})
				})
			})
		})
	})
	expect(forceDraws).toBe(1)
})


test('raw formatter keeps printable ascii readable', () => {
	expect(cli.formatRawToken('a')).toBe("'a'")
	expect(cli.formatRawToken(' ')).toBe("' '")
	expect(cli.formatRawToken("'")).toBe("'\\\''")
})

test('raw formatter shows escape sequences as hex bytes', () => {
	expect(cli.formatRawToken('\x1b[27;2;13~')).toBe('[0x1b 0x5b 0x32 0x37 0x3b 0x32 0x3b 0x31 0x33 0x7e]')
})

test('raw mode coalesces tokens and exits on escape', () => {
	const sink = makeRawSink()
	cli.rawModeForTests.reset()
	cli.rawModeForTests.start(sink.emit)
	expect(cli.rawModeForTests.handle('ab\x1b[27;2;13~', sink.emit)).toBe(true)
	cli.rawModeForTests.flush(sink.emit)
	expect(sink.lines).toEqual([
		'Raw input mode on. Press Esc to exit.',
		"'a' 'b' [0x1b 0x5b 0x32 0x37 0x3b 0x32 0x3b 0x31 0x33 0x7e]",
	])
	
	expect(cli.rawModeForTests.handle('\x1b', sink.emit)).toBe(true)
	expect(sink.lines.at(-1)).toBe('Raw input mode off.')
	expect(cli.rawModeForTests.active()).toBe(false)
})


test('raw mode exits on kitty CSI-u escape too', () => {
	const sink = makeRawSink()
	cli.rawModeForTests.reset()
	cli.rawModeForTests.start(sink.emit)
	expect(cli.rawModeForTests.handle('\x1b[27;1u', sink.emit)).toBe(true)
	expect(sink.lines.at(-1)).toBe('Raw input mode off.')
	expect(cli.rawModeForTests.active()).toBe(false)
})


test('ctrl-shift-t queues resume of the most recently closed tab', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origTabs = client.state.tabs.slice()
	const origActiveTab = client.state.activeTab

	client.state.tabs.length = 0
	client.state.tabs.push({
		sessionId: '04-bbb',
		name: 'tab 2',
		history: [],
		inputHistory: [],
		inputDraft: '',
		parentEntryCount: 0,
		liveHistory: [],
		loaded: true,
		doneUnseen: false,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '/tmp',
		model: 'openai/gpt-5.4',
	})
	client.state.activeTab = 0
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 't', shift: true, ctrl: true, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([{ type: 'resume', sessionId: '04-bbb' }])
	} finally {
		ipc.appendCommand = origAppendCommand
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.activeTab = origActiveTab
	}
})

function makeTab(overrides: Partial<(typeof client.state.tabs)[number]> = {}): (typeof client.state.tabs)[number] {
	return {
		sessionId: 's1',
		name: 'tab 1',
		history: [],
		inputHistory: [],
		inputDraft: '',
		parentEntryCount: 0,
		liveHistory: [],
		loaded: true,
		doneUnseen: false,
		historyVersion: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0,
		contextMax: 0,
		cwd: '/tmp',
		model: 'openai/gpt-5.4',
		...overrides,
	}
}

function withOneTab(tab: (typeof client.state.tabs)[number], run: () => void): void {
	const origTabs = client.state.tabs.slice()
	const origActiveTab = client.state.activeTab
	try {
		client.state.tabs.length = 0
		client.state.tabs.push(tab)
		client.state.activeTab = 0
		run()
	} finally {
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.activeTab = origActiveTab
		prompt.clear()
		popup.close()
	}
}

test('enter on empty paused tab sends continue', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origTabs = client.state.tabs.slice()
	const origActiveTab = client.state.activeTab

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({ history: [{ type: 'info', text: '[paused]' }] as any[] }))
	client.state.activeTab = 0
	prompt.clear()
	client.state.busy.clear()
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([{ type: 'continue', sessionId: 's1' }])
	} finally {
		ipc.appendCommand = origAppendCommand
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.activeTab = origActiveTab
	}
})

test('enter on empty busy error tab sends continue', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origTabs = client.state.tabs.slice()
	const origActiveTab = client.state.activeTab

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({ history: [{ type: 'error', text: 'Stream read timed out (no data for 120000ms)' }] as any[] }))
	client.state.activeTab = 0
	prompt.clear()
	client.state.busy.set('s1', true)
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([{ type: 'continue', sessionId: 's1' }])
	} finally {
		ipc.appendCommand = origAppendCommand
		client.state.busy.clear()
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.activeTab = origActiveTab
	}
})

test('enter on empty busy retry status does not interrupt backoff', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origTabs = client.state.tabs.slice()
	const origActiveTab = client.state.activeTab

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({
		history: [
			{ type: 'error', text: '429: rate limited' },
			{ type: 'info', text: 'Rate limited — retrying in 10s' },
		] as any[],
	}))
	client.state.activeTab = 0
	prompt.clear()
	client.state.busy.set('s1', true)
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([])
	} finally {
		ipc.appendCommand = origAppendCommand
		client.state.busy.clear()
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.activeTab = origActiveTab
	}
})

test('enter on empty normal tab does not send continue', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origTabs = client.state.tabs.slice()
	const origActiveTab = client.state.activeTab

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab())
	client.state.activeTab = 0
	prompt.clear()
	client.state.busy.clear()
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([])
	} finally {
		ipc.appendCommand = origAppendCommand
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.activeTab = origActiveTab
	}
})


test('large stale Claude session opens overage confirmation before sending', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const tab = makeTab({
		model: 'anthropic/claude-opus-4-7',
		contextUsed: 170_000,
		history: [{ type: 'assistant', text: 'old', model: 'anthropic/claude-opus-4-7', ts: Date.now() - 24 * 60 * 60 * 1000 }],
	})
	ipc.appendCommand = (command) => { commands.push(command) }
	try {
		withOneTab(tab, () => {
			prompt.setText('hi')
			const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
			expect(handled).toBe(true)
			expect(commands).toEqual([])
			expect(popup.state.active).toBe(true)
			expect(popup.state.title).toBe('Claude cache likely cold')
			expect(prompt.text()).toBe('hi')
		})
	} finally {
		ipc.appendCommand = origAppendCommand
	}
})

test('large stale Claude confirmation sends when accepted', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const tab = makeTab({
		model: 'anthropic/claude-opus-4-7',
		contextUsed: 170_000,
		history: [{ type: 'assistant', text: 'old', model: 'anthropic/claude-opus-4-7', ts: Date.now() - 24 * 60 * 60 * 1000 }],
	})
	ipc.appendCommand = (command) => { commands.push(command) }
	try {
		withOneTab(tab, () => {
			prompt.setText('hi')
			cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
			popup.handleKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
			expect(commands).toMatchObject([{ type: 'prompt', text: 'hi' }])
			expect(prompt.text()).toBe('')
		})
	} finally {
		ipc.appendCommand = origAppendCommand
	}
})
