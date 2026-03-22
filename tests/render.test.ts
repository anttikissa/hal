import { describe, test, expect, beforeEach } from 'bun:test'
import {
	clearFrame,
	getRenderMetrics,
	render,
	type RenderState,
} from '../src/client/render.ts'

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

beforeEach(() => {
	clearFrame()
})

describe('render', () => {
	test('updates the changed prompt line by redrawing the frame region only', () => {
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

		const output = writes.join('')
		expect(output).toContain('\x1b[J')
		expect(output).not.toContain('\x1b[2J\x1b[H')
		expect(stripAnsi(output)).toContain('> x')
	})

	test('force redraw repaints the full frame when content overflows viewport', () => {
		const originalRows = process.stdout.rows
		Object.defineProperty(process.stdout, 'rows', {
			value: 4,
			configurable: true,
		})

		const writes: string[] = []
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = (chunk: any) => {
			writes.push(String(chunk))
			return true
		}

		try {
			const state: RenderState = {
				blocks: ['one\ntwo\nthree\nfour\nfive\nsix'],
				allTabBlockCounts: [6],
				tabs: 'tabs',
				separator: 'sep',
				prompt: '> ',
				cursorCol: 2,
			}

			render(state)
			writes.length = 0
			render(state, { force: true })

			expect(stripAnsi(writes.join('')).split('\n')).toEqual([
				'one',
				'two',
				'three',
				'four',
				'five',
				'six',
				'tabs',
				'sep',
				'> ',
			])
		} finally {
			;(process.stdout as any).write = originalWrite
			Object.defineProperty(process.stdout, 'rows', {
				value: originalRows,
				configurable: true,
			})
		}
	})

	test('force redraw handles tall-to-short tab switch and repaints full frame', () => {
		const originalRows = process.stdout.rows
		Object.defineProperty(process.stdout, 'rows', {
			value: 6,
			configurable: true,
		})

		const writes: string[] = []
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = (chunk: any) => {
			writes.push(String(chunk))
			return true
		}

		try {
			const tall: RenderState = {
				blocks: ['one\ntwo\nthree\nfour'],
				allTabBlockCounts: [4],
				tabs: 'tabs',
				separator: 'sep',
				prompt: '> ',
				cursorCol: 2,
			}
			const short: RenderState = {
				blocks: ['one'],
				allTabBlockCounts: [4],
				tabs: 'tabs',
				separator: 'sep',
				prompt: '> ',
				cursorCol: 2,
			}

			render(tall)
			writes.length = 0
			render(short, { force: true })

			const output = stripAnsi(writes.join(''))
			expect(output.split('\n')).toEqual([
				'',
				'',
				'one',
				'tabs',
				'sep',
				'> ',
			])
			expect(output).not.toContain('two')
			expect(output).not.toContain('three')
			expect(output).not.toContain('four')
		} finally {
			;(process.stdout as any).write = originalWrite
			Object.defineProperty(process.stdout, 'rows', {
				value: originalRows,
				configurable: true,
			})
		}
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

	test('clears only the current frame before restart', () => {
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

		expect(writes.join('')).toContain('\x1b[J')
		expect(writes.join('')).not.toContain('\x1b[2J\x1b[H')
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

	test('shrink redraw clears frame region without injecting blank scrollback line', () => {
		const originalRows = process.stdout.rows
		Object.defineProperty(process.stdout, 'rows', {
			value: 6,
			configurable: true,
		})

		const writes: string[] = []
		const originalWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as any).write = (chunk: any) => {
			writes.push(String(chunk))
			return true
		}

		try {
			render({
				blocks: ['one\ntwo\nthree\nfour'],
				allTabBlockCounts: [4],
				tabs: '1 tab 1',
				separator: 'sep',
				prompt: '> ',
				cursorCol: 2,
			})
			writes.length = 0

			render({
				blocks: ['one\ntwo'],
				allTabBlockCounts: [2],
				tabs: '1 tab 1',
				separator: 'sep',
				prompt: '> ',
				cursorCol: 2,
			})

			const output = writes.join('')
			expect(output).toContain('\x1b[J')
			expect(output).not.toContain('\x1b[2J\x1b[H')
			expect(output).not.toContain('\r\n\x1b[J')
		} finally {
			;(process.stdout as any).write = originalWrite
			Object.defineProperty(process.stdout, 'rows', {
				value: originalRows,
				configurable: true,
			})
		}
	})
})
