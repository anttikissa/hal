import { expect, test } from 'bun:test'
import { cli } from './cli.ts'
import { client } from '../client.ts'
import { ipc } from '../ipc.ts'

function makeRawSink(): { lines: string[]; emit: (text: string) => void } {
	const lines: string[] = []
	return { lines, emit: (text) => lines.push(text) }
}

test('all user submissions use prompt commands even while busy', () => {
	expect(cli.submitCommandType('/help', false)).toBe('prompt')
	expect(cli.submitCommandType('/help', true)).toBe('prompt')
	expect(cli.submitCommandType('/model gpt-5.4', false)).toBe('prompt')
	expect(cli.submitCommandType('/model gpt-5.4', true)).toBe('prompt')
	expect(cli.submitCommandType('hello', false)).toBe('prompt')
	expect(cli.submitCommandType('hello', true)).toBe('prompt')
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
		expect(commands).toEqual([{ type: 'resume', text: undefined, sessionId: '04-bbb' }])
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

test('enter on empty paused tab sends continue', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origTabs = client.state.tabs.slice()
	const origActiveTab = client.state.activeTab

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({ history: [{ type: 'info', text: '[paused]' }] as any[] }))
	client.state.activeTab = 0
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([{ type: 'continue', text: undefined, sessionId: 's1' }])
	} finally {
		ipc.appendCommand = origAppendCommand
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
