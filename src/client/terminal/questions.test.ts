import { afterEach, expect, test } from 'bun:test'
import { client } from '../app.ts'
import { clientTransport } from '../transport.ts'
import { prompt } from './prompt.ts'
import { questionCrypto } from '../../common/question-crypto.ts'
import { terminalQuestions } from './questions.ts'

function key(key: string, mods: any = {}): any {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

function question(input: any, id = 'q1'): any {
	return { type: 'question', id, text: 'Answer this', input, source: { type: 'intro' }, active: true }
}

function withQuestion(block: any, run: () => void | Promise<void>): Promise<void> | void {
	const tabs = client.state.tabs
	const focused = client.state.focusedTabIndex
	tabs.push({
		sessionId: 's1', name: 'test', history: [block], inputHistory: [], inputDraft: '', parentEntryCount: 0,
		loaded: true, doneUnseen: false, historyVersion: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		contextUsed: 0, contextMax: 0, cwd: '/tmp', model: 'openai/gpt-5.4',
	} as any)
	client.state.focusedTabIndex = tabs.length - 1
	const finish = () => {
		tabs.pop()
		client.state.focusedTabIndex = focused
		terminalQuestions.reset()
		prompt.clear()
	}
	try {
		const result = run()
		if (result instanceof Promise) return result.finally(finish)
		finish()
	} catch (error) {
		finish()
		throw error
	}
}

afterEach(() => terminalQuestions.reset())

test('choice starts on No, owns ordinary keys, and answers by keyboard', () => withQuestion(question({ kind: 'choice', choices: [
	{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' },
]}), () => {
	const commands: any[] = []
	const append = clientTransport.io.appendCommand
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	prompt.setText('ordinary draft', 3)
	try {
		expect(terminalQuestions.selectedIndex()).toBe(0)
		expect(terminalQuestions.handleKey(key('x', { char: 'x' }))).toBe(true)
		expect(prompt.text()).toBe('ordinary draft')
		expect(terminalQuestions.handleKey(key('right'))).toBe(true)
		expect(terminalQuestions.selectedIndex()).toBe(1)
		expect(terminalQuestions.handleKey(key('enter'))).toBe(true)
		expect(commands).toEqual([{ type: 'answer', sessionId: 's1', questionId: 'q1', value: { kind: 'choice', choiceId: 'yes' } }])
	} finally {
		clientTransport.io.appendCommand = append
	}
}))

test('choice digits and y/n submit matching choices', () => withQuestion(question({ kind: 'choice', choices: [
	{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' },
]}), () => {
	const commands: any[] = []
	const append = clientTransport.io.appendCommand
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	try {
		terminalQuestions.handleKey(key('y', { char: 'y' }))
		expect(commands.at(-1)?.value).toEqual({ kind: 'choice', choiceId: 'yes' })
		terminalQuestions.handleKey(key('1', { char: '1' }))
		expect(commands.at(-1)?.value).toEqual({ kind: 'choice', choiceId: 'no' })
	} finally {
		clientTransport.io.appendCommand = append
	}
}))

test('text question uses multiline prompt editing without changing the ordinary draft', () => withQuestion(question({ kind: 'text' }), () => {
	const commands: any[] = []
	const append = clientTransport.io.appendCommand
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	prompt.setText('ordinary draft', 2)
	const ordinary = prompt.snapshotState()
	try {
		terminalQuestions.handleKey(key('a', { char: 'a' }))
		terminalQuestions.handleKey(key('enter', { shift: true }))
		terminalQuestions.handleKey(key('b', { char: 'b' }))
		expect(terminalQuestions.text()).toBe('a\nb')
		terminalQuestions.handleKey(key('enter'))
		expect(commands.at(-1)).toMatchObject({ type: 'answer', questionId: 'q1', value: { kind: 'text', text: 'a\nb' } })
		expect(prompt.snapshotState()).toEqual(ordinary)
	} finally {
		clientTransport.io.appendCommand = append
	}
}))

test('secret masks, clears before encryption settles, and sends only ciphertext', async () => {
	await withQuestion(question({ kind: 'secret', publicKey: 'key', maxBytes: 190 }), async () => {
		const commands: any[] = []
		const append = clientTransport.io.appendCommand
		const encrypt = questionCrypto.encryptSecret
		let resolve!: (value: string) => void
		questionCrypto.encryptSecret = (() => new Promise<string>((done) => { resolve = done })) as typeof encrypt
		clientTransport.io.appendCommand = (command) => { commands.push(command) }
		try {
			terminalQuestions.handleKey(key('paste', { char: 'code#state' }))
			expect(terminalQuestions.secretDisplay()).toBe('**********')
			terminalQuestions.handleKey(key('enter'))
			expect(terminalQuestions.secretDisplay()).toBe('')
			expect(commands).toEqual([])
			resolve('encrypted')
			await Bun.sleep(0)
			expect(commands).toEqual([{ type: 'answer', sessionId: 's1', questionId: 'q1', value: { kind: 'secret', ciphertext: 'encrypted' } }])
		} finally {
			questionCrypto.encryptSecret = encrypt
			clientTransport.io.appendCommand = append
		}
	})
})


test('secret enforces the UTF-8 byte bound before encryption', () => withQuestion(question({ kind: 'secret', publicKey: 'key', maxBytes: 190 }), () => {
	const commands: any[] = []
	const append = clientTransport.io.appendCommand
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	try {
		terminalQuestions.handleKey(key('paste', { char: 'é'.repeat(96) }))
		terminalQuestions.handleKey(key('enter'))
		expect(commands).toEqual([])
		expect(terminalQuestions.error(terminalQuestions.activeQuestion()!)).toContain('190')
	} finally {
		clientTransport.io.appendCommand = append
	}
}))


test('background tabs never steal focus and secret input survives tab switches but clears on resolution', () => withQuestion(question({ kind: 'secret', publicKey: 'key', maxBytes: 190 }), () => {
	terminalQuestions.handleKey(key('paste', { char: 'private' }))
	const questionTab = client.currentTab()!
	const background = { ...questionTab, sessionId: 's2', history: [], inputHistory: [], inputDraft: '' }
	client.state.tabs.push(background)
	try {
		client.state.focusedTabIndex++
		expect(terminalQuestions.handleKey(key('x', { char: 'x' }))).toBe(false)
		client.state.focusedTabIndex--
		expect(terminalQuestions.secretDisplay()).toBe('*******')
		questionTab.history = []
		terminalQuestions.activeQuestion()
		questionTab.history = [question({ kind: 'secret', publicKey: 'key', maxBytes: 190 })]
		expect(terminalQuestions.secretDisplay()).toBe('')
	} finally {
		client.state.tabs.pop()
	}
}))


test('authoritative reload of the same active question preserves its editor state', () => withQuestion(question({ kind: 'text' }), () => {
	terminalQuestions.handleKey(key('a', { char: 'a' }))
	client.currentTab()!.history = [question({ kind: 'text' })]

	expect(terminalQuestions.text()).toBe('a')
}))

test('Escape aborts the active question', () => withQuestion(question({ kind: 'text' }), () => {
	const commands: any[] = []
	const append = clientTransport.io.appendCommand
	clientTransport.io.appendCommand = (command) => { commands.push(command) }
	try {
		expect(terminalQuestions.handleKey(key('escape'))).toBe(true)
		expect(commands).toEqual([{ type: 'abort', sessionId: 's1' }])
	} finally {
		clientTransport.io.appendCommand = append
	}
}))
