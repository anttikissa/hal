import { expect, test } from 'bun:test'
import { cli } from './cli.ts'
import { client } from '../client.ts'
import { ipc } from '../ipc.ts'
import { prompt } from '../cli/prompt.ts'
import { render } from './render.ts'
import { cursor } from '../cli/cursor.ts'
import { popup } from './popup.ts'

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


test('external editor suppresses resize redraws', () => {
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
									cli.forTests.setExternalEditorOpen(true)
									for (const listener of sigwinch) listener()
									cli.forTests.setExternalEditorOpen(false)
									controller.abort()
								})
							})
						})
					})
				})
			})
		})
	})
	expect(forceDraws).toBe(0)
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

test('model picker keeps the prompt draft after choosing a model', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	prompt.setText('draft prompt')

	withPatched(render, 'draw', (() => {}) as typeof render.draw, () => {
		withOneTab(makeTab(), () => {
			ipc.appendCommand = (command) => { commands.push(command) }
			try {
				const opened = cli.forTests.handleAppKey({ key: 'm', shift: false, ctrl: true, alt: false, cmd: false })
				expect(opened).toBe(true)
				expect(popup.state.active).toBe(true)

				const chosen = popup.handleKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
				expect(chosen).toBe(true)

				expect(commands).toEqual([expect.objectContaining({ type: 'prompt', sessionId: 's1', text: '/model gpt' })])
				expect(prompt.text()).toBe('draft prompt')
			} finally {
				ipc.appendCommand = origAppendCommand
			}
		})
	})
})


test('ctrl-f saves the current prompt draft before forking', () => {
	const commands: any[] = []
	const drafts: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origSaveDraft = client.saveDraft
	const tab = makeTab({ sessionId: 's1' })

	ipc.appendCommand = (command) => { commands.push(command) }
	client.saveDraft = (text, sessionId) => { drafts.push({ text, sessionId }) }

	try {
		withOneTab(tab, () => {
			prompt.setText('draft prompt')
			const handled = cli.forTests.handleAppKey({ key: 'f', shift: false, ctrl: true, alt: false, cmd: false })

			expect(handled).toBe(true)
			expect(drafts).toEqual([{ text: 'draft prompt', sessionId: 's1' }])
			expect(commands).toEqual([{ type: 'open', sessionId: 's1', forkSessionId: 's1' }])
		})
	} finally {
		ipc.appendCommand = origAppendCommand
		client.saveDraft = origSaveDraft
	}
})

test('alt-enter queues prompt without binding cmd-enter', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const tab = makeTab()
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		withOneTab(tab, () => {
			prompt.setText('do this next')
			const queued = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: true, cmd: false })
			expect(queued).toBe(true)
			expect(commands).toEqual([expect.objectContaining({ type: 'prompt', sessionId: 's1', text: 'do this next', delivery: 'queue' })])
			expect(prompt.text()).toBe('')

			prompt.setText('cmd should not queue')
			const cmdHandled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: true })
			expect(cmdHandled).toBe(false)
			expect(commands).toHaveLength(1)
		})
	} finally {
		ipc.appendCommand = origAppendCommand
	}
})

test('ctrl-q runs the next queued prompt', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		withOneTab(makeTab(), () => {
			const handled = cli.forTests.handleAppKey({ key: 'q', shift: false, ctrl: true, alt: false, cmd: false })
			expect(handled).toBe(true)
			expect(commands).toEqual([{ type: 'queue-next', sessionId: 's1' }])
		})
	} finally {
		ipc.appendCommand = origAppendCommand
	}
})


test('/keys is local terminal help and does not send a prompt while busy', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const tab = makeTab()
	ipc.appendCommand = (command) => { commands.push(command) }

	try {
		client.state.busy.set('s1', true)
		withOneTab(tab, () => {
			prompt.setText('/keys')
			const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })

			expect(handled).toBe(true)
			expect(commands).toEqual([])
			expect(prompt.text()).toBe('')
			expect(tab.inputHistory).toContain('/keys')
			expect(tab.history.at(-1)).toMatchObject({ type: 'log', text: expect.stringContaining('cmd+c') })
		})
	} finally {
		ipc.appendCommand = origAppendCommand
		client.state.busy.clear()
	}
})

test('enter on empty paused tab sends continue', () => {
	const commands: any[] = []
	const origAppendCommand = ipc.appendCommand
	const origTabs = client.state.tabs.slice()
	const origActiveTab = client.state.activeTab

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({ history: [{ type: 'log', text: '[paused]' }] as any[] }))
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
