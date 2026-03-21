import { describe, test, expect } from 'bun:test'
import {
	clearFrame,
	getRenderMetrics,
	render,
	type RenderState,
} from '../src/client/render.ts'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

describe('render', () => {
	test('counts multi-line separator when moving back to frame top', () => {
		const state: RenderState = {
			blocks: [],
			allTabBlockCounts: [0],
			tabs: '1 tab 1',
			separator: 'debug\nseparator',
			prompt: '> ',
			cursorCol: 2,
		}

		const writes: string[] = []
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = (chunk: any) => {
			writes.push(String(chunk))
			return true
		}

		render(state)
		writes.length = 0
		render({ ...state, prompt: '> x', cursorCol: 4 })

		;(process.stdout as any).write = originalWrite

		expect(writes.join('')).toContain('\x1b[3A')
	})

	test('pads above short tabs so messages stay near the prompt', () => {
		const state: RenderState = {
			blocks: ['hello'],
			allTabBlockCounts: [3],
			tabs: 'tabs',
			separator: 'sep',
			prompt: '> ',
			cursorCol: 2,
		}

		const writes: string[] = []
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = (chunk: any) => {
			writes.push(String(chunk))
			return true
		}

		render(state)

		;(process.stdout as any).write = originalWrite

		expect(stripAnsi(writes.join('')).split('\n')).toEqual([
			'',
			'',
			'hello',
			'tabs',
			'sep',
			'> ',
		])
	})

	test('clears the current frame before restart', () => {
		const state: RenderState = {
			blocks: ['one', 'two'],
			allTabBlockCounts: [2],
			tabs: '1 tab 1',
			separator: 'sep',
			prompt: '> ',
			cursorCol: 2,
		}

		const writes: string[] = []
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = (chunk: any) => {
			writes.push(String(chunk))
			return true
		}

		render(state)
		writes.length = 0
		clearFrame()

		;(process.stdout as any).write = originalWrite

		expect(writes.join('')).toContain('\r\x1b[4A\x1b[J')
	})

	test('reports current frame metrics', () => {
		const metrics = getRenderMetrics(
			{
				blocks: ['one', 'two\nthree'],
				allTabBlockCounts: [5, 1],
				tabs: '1 tab 1',
				prompt: '> abc',
			},
			2,
		)

		expect(metrics).toEqual({
			contentLines: 3,
			padding: 2,
			maxContentHeight: 5,
			totalLines: 9,
		})
	})
})
