import { beforeEach, expect, test } from 'bun:test'
import { render } from '../src/client/render.ts'
import { client } from '../src/client.ts'
import { prompt } from '../src/cli/prompt.ts'
import { helpBar } from '../src/cli/help-bar.ts'
import { popup } from '../src/client/popup.ts'

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
	client.state.tabs.push({
		sessionId: 'test-session-with-a-very-long-id',
		name: 'tab 1',
		history: [],
		inputHistory: [],
		loaded: true,
		inputDraft: '',
		doneUnseen: false, parentEntryCount: 0,
		historyVersion: 0,
		usage: { input: 1234567, output: 7654321 },
		contextUsed: 999999,
		contextMax: 1000000,
		cwd: '/Users/antti/projects/some/really/long/path/that/should/not/wrap/in/the/status/line',
		model: 'openai/gpt-5.4',
	})
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
})

test('status and help bar are clipped to terminal width', () => {
	const originalCols = process.stdout.columns
	Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })
	try {
		const clean = stripAnsi(captureOutput(() => render.draw(true)))
		for (const line of clean.split('\n')) {
			expect(line.length).toBeLessThanOrEqual(40)
		}
	} finally {
		Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true })
	}
})
