import { describe, test, expect, beforeEach } from 'bun:test'
import { render } from '../src/client/render.ts'
import { client } from '../src/client.ts'
import { prompt } from '../src/cli/prompt.ts'

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
	client.state.tabs.push({ sessionId: 'test', name: 'tab 1', history: [], inputHistory: [], loaded: true, inputDraft: '', doneUnseen: false, streamingText: '', streamingThinking: '', usage: { input: 0, output: 0 }, contextUsed: 0, contextMax: 0, cwd: '/tmp', model: 'test' })
	client.state.activeTab = 0
	client.state.pid = 111
	client.state.hostPid = 222
	prompt.clear()
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

	test('status line shows local pid', () => {
		const clean = stripAnsi(captureOutput(() => render.draw()))
		expect(clean).toContain('server:111')
		expect(clean).not.toContain('lock:')
	})
})
