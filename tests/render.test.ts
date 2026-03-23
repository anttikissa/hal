import { describe, test, expect, beforeEach } from 'bun:test'
import { draw, resetRenderer } from '../src/client/render.ts'
import * as client from '../src/client.ts'

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
	resetRenderer()
	client.state.tabs.length = 0
	client.state.tabs.push({ sessionId: 'test', name: 'tab 1', history: [] })
	client.state.activeTab = 0
	client.state.promptText = ''
	client.state.promptCursor = 0
})

describe('render', () => {
	test('diff engine only rewrites changed lines', () => {
		captureOutput(() => draw())
		client.state.promptText = 'x'
		const output = captureOutput(() => draw())
		expect(output).not.toContain('\x1b[2J\x1b[H')
		expect(stripAnsi(output)).toContain('> x')
	})

	test('force repaint in grow mode does not clear scrollback', () => {
		captureOutput(() => draw())
		const output = captureOutput(() => draw(true))
		expect(output).toContain('\x1b[J')
		expect(output).not.toContain('\x1b[3J')
	})

	test('writes ALL lines on force repaint', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'info', text: 'hello' })
		tab.history.push({ type: 'info', text: 'world' })
		captureOutput(() => draw())
		const output = captureOutput(() => draw(true))
		const clean = stripAnsi(output)
		expect(clean).toContain('hello')
		expect(clean).toContain('world')
	})
})
