import { describe, test, expect, beforeEach } from 'bun:test'
import { render } from '../src/client/render.ts'
import { client } from '../src/client.ts'
import { prompt } from '../src/cli/prompt.ts'
import { helpBar } from '../src/cli/help-bar.ts'
import { popup } from '../src/client/popup.ts'
import { blocks as blockRenderer } from '../src/cli/blocks.ts'

describe('render single pass', () => {
	beforeEach(() => {
		render.resetRenderer()
		client.state.tabs.length = 0
		client.state.tabs.push({
			sessionId: 'test',
			name: 'tab 1',
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

	test('history changes render each block once per draw', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'info', text: 'one' })
		tab.history.push({ type: 'info', text: 'two' })
		tab.historyVersion = 1
		const origRenderBlock = blockRenderer.renderBlock
		let calls = 0
		blockRenderer.renderBlock = (block, cols) => {
			calls++
			return origRenderBlock(block, cols)
		}
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = () => true
		try {
			render.draw()
			expect(calls).toBe(2)
		} finally {
			(process.stdout as any).write = originalWrite
			blockRenderer.renderBlock = origRenderBlock
		}
	})

	test('prompt-only redraw reuses cached history render', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'info', text: 'one' })
		tab.history.push({ type: 'info', text: 'two' })
		tab.historyVersion = 1
		const origRenderBlock = blockRenderer.renderBlock
		let calls = 0
		blockRenderer.renderBlock = (block, cols) => {
			calls++
			return origRenderBlock(block, cols)
		}
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = () => true
		try {
			render.draw()
			prompt.setText('x')
			render.draw()
			expect(calls).toBe(2)
		} finally {
			(process.stdout as any).write = originalWrite
			blockRenderer.renderBlock = origRenderBlock
		}
	})

	test('streaming redraw only rerenders the changed block', () => {
		const tab = client.currentTab()!
		tab.history.push({ type: 'info', text: 'one' })
		tab.history.push({ type: 'assistant', text: 'a' })
		const origRenderBlock = blockRenderer.renderBlock
		const calls: string[] = []
		blockRenderer.renderBlock = (block, cols) => {
			calls.push(`${block.type}:${'text' in block ? block.text : ''}`)
			return origRenderBlock(block, cols)
		}
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = () => true
		try {
			render.draw()
			const last = tab.history[1] as typeof tab.history[number] & { renderVersion?: number }
			if (!last || last.type !== 'assistant') throw new Error('expected assistant block')
			last.text += 'b'
			last.renderVersion = 1
			render.draw()
			expect(calls).toEqual(['info:one', 'assistant:a', 'assistant:ab'])
		} finally {
			(process.stdout as any).write = originalWrite
			blockRenderer.renderBlock = origRenderBlock
		}
	})
})
