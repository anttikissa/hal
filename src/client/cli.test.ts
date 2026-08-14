import { expect, test } from 'bun:test'
import { cli } from './cli.ts'
import { client } from './app.ts'
import { clientTransport } from './transport.ts'
import { prompt } from './terminal/prompt.ts'
import { render } from './render.ts'
import { cursor } from './terminal/cursor.ts'
import { popup } from './popup.ts'
import { promptEdit } from './prompt-edit.ts'
import { draft } from './terminal/draft.ts'

function key(key: string, mods: any = {}): any {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}
function withPatched<T extends object, K extends keyof T>(object: T, key: K, value: T[K], run: () => void): void {
	const original = object[key]
	object[key] = value
	try { run() }
	finally { object[key] = original }
}

test('kitty keyboard mode does not request key release events', () => {
	// Ghostty sends Cmd-C-in-scrollback as only a key-release event when report
	// events is enabled; that pty input snaps scrollback to the bottom.
	expect(cli.forTests.kittyOnSequence()).toBe('\x1b[>17u')
})

test('prompt key handling uses rendered prompt content width', () => {
	const originalCols = process.stdout.columns
	Object.defineProperty(process.stdout, 'columns', { value: 111, configurable: true })
	try {
		expect(cli.forTests.promptInputWidth()).toBe(109)
	} finally {
		Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
	}
})

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
	const origAppendCommand = clientTransport.io.appendCommand
	const origTabs = client.state.tabs.slice()
	const origFocusedTab = client.state.focusedTabIndex

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
	client.state.focusedTabIndex = 0
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 't', shift: true, ctrl: true, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([{ type: 'resume', sessionId: '04-bbb' }])
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
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
	const origFocusedTab = client.state.focusedTabIndex
	const origPendingPromptTexts = new Map(client.state.pendingPromptTexts)
	try {
		client.state.tabs.length = 0
		client.state.tabs.push(tab)
		client.state.focusedTabIndex = 0
		run()
	} finally {
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
		client.state.pendingPromptTexts.clear()
		for (const [sessionId, text] of origPendingPromptTexts) client.state.pendingPromptTexts.set(sessionId, text)
		prompt.clear()
		popup.close()
		promptEdit.cancel()
	}
}

test('tab switching preserves the full prompt editor state', () => {
	const tab1 = makeTab({ sessionId: 's1', inputHistory: ['old prompt'] })
	const tab2 = makeTab({ sessionId: 's2', inputDraft: 'second draft' })
	const origTabs = client.state.tabs.slice()
	const origFocusedTab = client.state.focusedTabIndex
	const origSaveDraft = client.saveDraft
	client.saveDraft = () => {}

	try {
		withPatched(render, 'draw', (() => {}) as typeof render.draw, () => {
			client.state.tabs.length = 0
			client.state.tabs.push(tab1, tab2)
			client.state.focusedTabIndex = 0
			cli.forTests.resetPromptStates()
			cli.forTests.installPromptTabSwitchHandler()
			prompt.setHistory(client.getInputHistory())
			prompt.setText('')
			prompt.handleKey(key('up'), 80)
			prompt.handleKey({ key: '!', char: '!', shift: false, alt: false, ctrl: false, cmd: false }, 80)
			const cursorBefore = prompt.cursorPos()

			client.switchTab(1)
			expect(prompt.text()).toBe('second draft')
			client.switchTab(0)

			expect(prompt.text()).toBe('old prompt!')
			expect(prompt.cursorPos()).toBe(cursorBefore)
			prompt.handleKey(key('down'), 80)
			expect(prompt.text()).toBe('')
		})
	} finally {
		client.saveDraft = origSaveDraft
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
		client.setOnTabSwitch(() => {})
		cli.forTests.resetPromptStates()
		prompt.clear()
	}
})


test('idle up uses normal prompt history without edit mode hint', () => {
	const tab = makeTab({ inputHistory: ['old prompt'] })
	client.state.working.clear()

	withOneTab(tab, () => {
		prompt.clear()
		expect(cli.forTests.handleAppKey(key('up'))).toBe(false)
		expect(promptEdit.activeFor('s1')).toBe(null)
		expect(promptEdit.hint('s1')).toBe(null)
	})
})


test('just-sent edit mode survives tab switching', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const origSaveDraft = client.saveDraft
	const tab1 = makeTab({ sessionId: 's1', inputHistory: ['original prompt'], history: [{ type: 'user', text: 'original prompt' }, { type: 'assistant', text: 'partial' }] as any[] })
	const tab2 = makeTab({ sessionId: 's2', inputDraft: 'second draft' })
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.saveDraft = () => {}
	client.state.working.set('s1', true)

	try {
		withPatched(render, 'draw', (() => {}) as typeof render.draw, () => {
			client.state.tabs.length = 0
			client.state.tabs.push(tab1, tab2)
			client.state.focusedTabIndex = 0
			cli.forTests.resetPromptStates()
			cli.forTests.installPromptTabSwitchHandler()
			prompt.clear()

			expect(cli.forTests.handleAppKey(key('up'))).toBe(true)
			expect(promptEdit.hint('s1')).toContain('editing just-sent prompt')
			prompt.setText('edited prompt')

			client.switchTab(1)
			expect(prompt.text()).toBe('second draft')
			expect(promptEdit.activeFor('s1')).not.toBe(null)
			expect(promptEdit.hint('s2')).toBe(null)

			client.switchTab(0)
			expect(prompt.text()).toBe('edited prompt')
			expect(promptEdit.hint('s1')).toContain('editing just-sent prompt')
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.saveDraft = origSaveDraft
		client.state.working.clear()
		client.setOnTabSwitch(() => {})
		cli.forTests.resetPromptStates()
		prompt.clear()
		promptEdit.cancel()
	}
})

test('model picker keeps the prompt draft and skips unchanged model', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	prompt.setText('draft prompt')

	withPatched(render, 'draw', (() => {}) as typeof render.draw, () => {
		withOneTab(makeTab(), () => {
			clientTransport.io.appendCommand = (command) => { commands.push(command) }
			try {
				const opened = cli.forTests.handleAppKey({ key: 'm', shift: false, ctrl: true, alt: false, cmd: false })
				expect(opened).toBe(true)
				expect(popup.state.active).toBe(true)

				const chosen = popup.handleKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
				expect(chosen).toBe(true)

				expect(commands).toEqual([])
				expect(prompt.text()).toBe('draft prompt')
			} finally {
				clientTransport.io.appendCommand = origAppendCommand
			}
		})
	})
})


test('ctrl-f saves the current prompt draft before forking', () => {
	const commands: any[] = []
	const drafts: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const origSaveDraft = client.saveDraft
	const tab = makeTab({ sessionId: 's1' })

	clientTransport.io.appendCommand = (command) => { commands.push(command) }
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
		clientTransport.io.appendCommand = origAppendCommand
		client.saveDraft = origSaveDraft
	}
})

test('alt-enter queues prompt without binding cmd-enter', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab()
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		withOneTab(tab, () => {
			prompt.setText('do this next')
			const queued = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: true, cmd: false })
			expect(queued).toBe(true)
			expect(commands).toEqual([expect.objectContaining({ type: 'prompt', sessionId: 's1', text: 'do this next', queue: true })])
			expect(prompt.text()).toBe('')

			prompt.setText('cmd should not queue')
			const cmdHandled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: true })
			expect(cmdHandled).toBe(false)
			expect(commands).toHaveLength(1)
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
	}
})

test('up while working before output edits the just-sent prompt', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({ inputHistory: ['original prompt'], history: [{ type: 'user', text: 'original prompt' }] as any[] })
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.clear()
			const handled = cli.forTests.handleAppKey(key('up'))
			expect(handled).toBe(true)
			expect(prompt.text()).toBe('original prompt')
			expect(tab.history[0]).toMatchObject({ status: 'editing' })
			expect(commands).toEqual([{ type: 'abort', sessionId: 's1', abortText: '' }])

			prompt.setText('edited prompt')
			cli.forTests.handleAppKey(key('enter'))
			expect(commands.at(-1)).toEqual({ type: 'prompt-amend', sessionId: 's1', text: 'edited prompt', displayText: undefined })
			expect(prompt.text()).toBe('')
			expect(promptEdit.state.active).toBe(null)
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})

test('up immediately after submit pauses before shared working state arrives', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({
		inputHistory: ['old prompt'],
		history: [{ type: 'user', text: 'old prompt' }, { type: 'assistant', text: 'old answer' }] as any[],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		withOneTab(tab, () => {
			prompt.setText('original prompt')
			expect(cli.forTests.handleAppKey(key('enter'))).toBe(true)

			expect(cli.forTests.handleAppKey(key('up'))).toBe(true)
			expect(prompt.text()).toBe('original prompt')
			expect(commands).toEqual([
				expect.objectContaining({ type: 'prompt', sessionId: 's1', text: 'original prompt' }),
				{ type: 'abort', sessionId: 's1', abortText: '' },
			])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		client.state.pendingPromptTexts.clear()
		promptEdit.cancel()
	}
})

test('host delivers prompt and abort directly instead of waiting for disk IPC', () => {
	const disk: any[] = []
	const urgent: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab()
	clientTransport.io.appendCommand = (command) => { disk.push(command) }
	client.state.localCommandHandler = (command) => { urgent.push(command) }

	try {
		withOneTab(tab, () => {
			client.sendCommand('prompt', 'hello')
			client.sendCommand('abort', '')
			expect(urgent).toEqual([
				{ type: 'prompt', sessionId: 's1', text: 'hello', displayText: undefined, queue: undefined },
				{ type: 'abort', sessionId: 's1', abortText: '' },
			])
			expect(disk).toEqual([])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.localCommandHandler = null
	}
})


test('up while working edits pasted prompt contents instead of display marker', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const actual = 'Analyze this:\n\nline one\nline two\nline three'
	const display = 'Analyze this:\n\n[/tmp/hal/paste/0002.txt]'
	const tab = makeTab({
		inputHistory: [actual],
		history: [{ type: 'user', text: display, actualText: actual }] as any[],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.clear()
			expect(cli.forTests.handleAppKey(key('up'))).toBe(true)
			expect(prompt.text()).toBe(actual)

			cli.forTests.handleAppKey(key('enter'))
			expect(commands.at(-1)).toEqual({ type: 'prompt-amend', sessionId: 's1', text: actual, displayText: undefined })
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})


test('up while working edits the visible latest prompt when local input history is stale', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({
		inputHistory: ['older prompt'],
		history: [{ type: 'user', text: 'latest visible prompt' }] as any[],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.clear()
			const handled = cli.forTests.handleAppKey(key('up'))
			expect(handled).toBe(true)
			expect(prompt.text()).toBe('latest visible prompt')
			expect(tab.history[0]).toMatchObject({ status: 'editing' })
			expect(commands).toEqual([{ type: 'abort', sessionId: 's1', abortText: '' }])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})

test('up while working does not copy an inbox handoff as a prompt', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({
		inputHistory: ['my prompt'],
		history: [
			{ type: 'user', text: 'my prompt' },
			{ type: 'user', text: 'handoff from another tab', source: 'other-session' },
		] as any[],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.clear()
			expect(cli.forTests.handleAppKey(key('up'))).toBe(true)
			expect(prompt.text()).toBe('my prompt')
			expect(promptEdit.state.active).toMatchObject({ originalText: 'my prompt', mode: 'cancel' })
			expect(tab.history[1]).toMatchObject({ source: 'other-session' })
			expect((tab.history[1] as any)?.status).toBeUndefined()
			expect(commands).toEqual([{ type: 'abort', sessionId: 's1', abortText: '' }])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})


test('up on newline draft while working stays in the prompt', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({ inputHistory: ['original prompt'], history: [{ type: 'user', text: 'original prompt' }] as any[] })
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.setText('\n')

			expect(cli.forTests.handleAppKey(key('up'))).toBe(false)
			expect(prompt.handleKey(key('up'), cli.forTests.promptInputWidth())).toBe(true)

			expect(prompt.cursorPos()).toBe(0)
			expect(promptEdit.activeFor('s1')).toBe(null)
			expect(commands).toEqual([])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})


test('up while working after visible output edits by canceling old turn', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({
		inputHistory: ['original prompt'],
		history: [
			{ type: 'user', text: 'original prompt' },
			{ type: 'assistant', text: 'partial answer' },
		] as any[],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.clear()
			expect(cli.forTests.handleAppKey(key('up'))).toBe(true)
			expect(prompt.text()).toBe('original prompt')
			expect((tab.history[0] as any).status).toBeUndefined()
			expect(commands).toEqual([{ type: 'abort', sessionId: 's1', abortText: '' }])

			prompt.setText('edited prompt')
			cli.forTests.handleAppKey(key('enter'))
			expect(commands.at(-1)).toEqual({ type: 'prompt-amend', sessionId: 's1', text: 'edited prompt', displayText: undefined })
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})


test('history navigation inside just-sent edit skips the already loaded prompt', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({
		inputHistory: ['older prompt', 'original prompt'],
		history: [{ type: 'user', text: 'original prompt' }] as any[],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.setHistory(tab.inputHistory)
			prompt.clear()
			expect(cli.forTests.handleAppKey(key('up'))).toBe(true)
			expect(prompt.text()).toBe('original prompt')

			expect(cli.forTests.handleAppKey(key('up'))).toBe(false)
			expect(prompt.handleKey(key('up'), cli.forTests.promptInputWidth())).toBe(true)
			expect(prompt.text()).toBe('older prompt')

			expect(cli.forTests.handleAppKey(key('down'))).toBe(false)
			expect(prompt.handleKey(key('down'), cli.forTests.promptInputWidth())).toBe(true)
			expect(prompt.text()).toBe('original prompt')
			expect(commands).toEqual([{ type: 'abort', sessionId: 's1', abortText: '' }])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})

test('down from just-sent edit continues the original prompt', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({ inputHistory: ['original prompt'], history: [{ type: 'user', text: 'original prompt' }] as any[] })
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.clear()
			cli.forTests.handleAppKey(key('up'))
			prompt.setText('edited but discarded')
			const handled = cli.forTests.handleAppKey(key('down'))
			expect(handled).toBe(true)
			expect(prompt.text()).toBe('')
			expect(tab.history[0]).toMatchObject({ status: undefined })
			expect(commands).toEqual([
				{ type: 'abort', sessionId: 's1', abortText: '' },
				{ type: 'continue', sessionId: 's1' },
			])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})


test('down from restored just-sent edit continues the original prompt', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({
		inputDraft: 'edited but discarded',
		inputDraftEdit: { mode: 'cancel', originalText: 'original prompt', pausedWorkingTurn: true },
		history: [{ type: 'user', text: 'original prompt' }, { type: 'assistant', text: 'partial' }] as any[],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		withOneTab(tab, () => {
			prompt.clear()
			cli.forTests.restorePromptForCurrentTab()

			expect(prompt.text()).toBe('edited but discarded')
			expect(promptEdit.hint('s1')).toContain('editing just-sent prompt')

			const handled = cli.forTests.handleAppKey(key('down'))
			expect(handled).toBe(true)
			expect(prompt.text()).toBe('')
			expect(commands).toEqual([{ type: 'continue', sessionId: 's1' }])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		promptEdit.cancel()
	}
})

test('tab switch loads empty draft when prompt-edit metadata exists', () => {
	const origLoadDraftState = draft.loadDraftState
	const origTabs = client.state.tabs.slice()
	const origFocusedTab = client.state.focusedTabIndex
	const tab1 = makeTab({ sessionId: 's1' })
	const tab2 = makeTab({ sessionId: 's2' })

	draft.loadDraftState = () => ({
		text: '',
		savedAt: '',
		promptEdit: { mode: 'cancel', originalText: 'original prompt', pausedWorkingTurn: true },
	})

	try {
		client.state.tabs.length = 0
		client.state.tabs.push(tab1, tab2)
		client.state.focusedTabIndex = 0

		client.switchTab(1)

		expect(tab2.inputDraft).toBe('')
		expect(tab2.inputDraftEdit).toMatchObject({ mode: 'cancel', originalText: 'original prompt' })
	} finally {
		draft.loadDraftState = origLoadDraftState
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
	}
})


test('down in just-sent edit moves through blank prompt lines before continuing', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({ inputHistory: ['original prompt'], history: [{ type: 'user', text: 'original prompt' }] as any[] })
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	client.state.working.set('s1', true)

	try {
		withOneTab(tab, () => {
			prompt.clear()
			cli.forTests.handleAppKey(key('up'))
			prompt.setText('edited\n\n', 'edited'.length)

			expect(cli.forTests.handleAppKey(key('down'))).toBe(false)
			expect(prompt.handleKey(key('down'), cli.forTests.promptInputWidth())).toBe(true)

			expect(prompt.cursorPos()).toBe('edited\n'.length)
			expect(promptEdit.activeFor('s1')).not.toBe(null)
			expect(commands).toEqual([{ type: 'abort', sessionId: 's1', abortText: '' }])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		promptEdit.cancel()
	}
})

test('ctrl-q runs the next queued prompt', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		withOneTab(makeTab(), () => {
			const handled = cli.forTests.handleAppKey({ key: 'q', shift: false, ctrl: true, alt: false, cmd: false })
			expect(handled).toBe(true)
			expect(commands).toEqual([{ type: 'run-next-from-queue', sessionId: 's1' }])
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
	}
})


test('/keys is local terminal help and does not send a prompt while working', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab()
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		client.state.working.set('s1', true)
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
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
	}
})

test('enter on empty paused tab sends continue', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const origTabs = client.state.tabs.slice()
	const origFocusedTab = client.state.focusedTabIndex

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({ history: [{ type: 'log', text: '[paused]' }] as any[] }))
	client.state.focusedTabIndex = 0
	prompt.clear()
	client.state.working.clear()
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([{ type: 'continue', sessionId: 's1' }])
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
	}
})

test('enter on empty working error tab does not retry again', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const origTabs = client.state.tabs.slice()
	const origFocusedTab = client.state.focusedTabIndex

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({ history: [{ type: 'error', text: 'Stream read timed out (no data for 120000ms)' }] as any[] }))
	client.state.focusedTabIndex = 0
	prompt.clear()
	client.state.working.set('s1', true)
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([])
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
	}
})


test('enter on empty error tab hides retry action immediately', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const origTabs = client.state.tabs.slice()
	const origFocusedTab = client.state.focusedTabIndex

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({ history: [{ type: 'error', text: 'Stream read timed out (no data for 120000ms)' }] as any[] }))
	client.state.focusedTabIndex = 0
	prompt.clear()
	client.state.working.clear()
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([{ type: 'continue', sessionId: 's1' }])
		expect(client.continueActionForCurrentTurn()).toBe(false)
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
	}
})

test('enter on empty working retry status does not interrupt backoff', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const origTabs = client.state.tabs.slice()
	const origFocusedTab = client.state.focusedTabIndex

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab({
		history: [
			{ type: 'error', text: '429: rate limited' },
			{ type: 'info', text: 'Rate limited — retrying in 10s' },
		] as any[],
	}))
	client.state.focusedTabIndex = 0
	prompt.clear()
	client.state.working.set('s1', true)
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([])
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.working.clear()
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
	}
})

test('enter on empty normal tab does not send continue', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const origTabs = client.state.tabs.slice()
	const origFocusedTab = client.state.focusedTabIndex

	client.state.tabs.length = 0
	client.state.tabs.push(makeTab())
	client.state.focusedTabIndex = 0
	prompt.clear()
	client.state.working.clear()
	clientTransport.io.appendCommand = (command) => { commands.push(command) }

	try {
		const handled = cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
		expect(handled).toBe(true)
		expect(commands).toEqual([])
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
		client.state.tabs.length = 0
		client.state.tabs.push(...origTabs)
		client.state.focusedTabIndex = origFocusedTab
	}
})


test('large stale Claude session opens overage confirmation before sending', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({
		model: 'anthropic/claude-opus-4-7',
		contextUsed: 170_000,
		history: [{ type: 'assistant', text: 'old', model: 'anthropic/claude-opus-4-7', ts: Date.now() - 24 * 60 * 60 * 1000 }],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
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
		clientTransport.io.appendCommand = origAppendCommand
	}
})

test('large stale Claude confirmation sends when accepted', () => {
	const commands: any[] = []
	const origAppendCommand = clientTransport.io.appendCommand
	const tab = makeTab({
		model: 'anthropic/claude-opus-4-7',
		contextUsed: 170_000,
		history: [{ type: 'assistant', text: 'old', model: 'anthropic/claude-opus-4-7', ts: Date.now() - 24 * 60 * 60 * 1000 }],
	})
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	try {
		withOneTab(tab, () => {
			prompt.setText('hi')
			cli.forTests.handleAppKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
			popup.handleKey({ key: 'enter', shift: false, ctrl: false, alt: false, cmd: false })
			expect(commands).toMatchObject([{ type: 'prompt', text: 'hi' }])
			expect(prompt.text()).toBe('')
		})
	} finally {
		clientTransport.io.appendCommand = origAppendCommand
	}
})
