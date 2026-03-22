import { describe, test, expect, beforeEach } from 'bun:test'
import { paint, resetRenderer, setFullscreen } from '../src/client/render.ts'

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
	try {
		fn()
	} finally {
		;(process.stdout as any).write = originalWrite
	}
	return writes.join('')
}

beforeEach(() => {
	resetRenderer()
})

describe('render', () => {
	test('diff engine only rewrites changed lines', () => {
		const frame1 = ['line 1', 'line 2', '> ']
		const frame2 = ['line 1', 'line 2', '> x']

		captureOutput(() => paint(frame1, { cursorCol: 2 }))
		const output = captureOutput(() => paint(frame2, { cursorCol: 3 }))

		// Should NOT contain full screen clear.
		expect(output).not.toContain('\x1b[2J\x1b[H')
		// Should contain the new prompt.
		expect(stripAnsi(output)).toContain('> x')
		// Should NOT re-render unchanged lines.
		expect(stripAnsi(output)).not.toContain('line 1')
	})

	test('force repaint in grow mode does not clear scrollback', () => {
		const frame = ['line 1', '> ']

		captureOutput(() => paint(frame))
		const output = captureOutput(() => paint(frame, { force: true }))

		// Should clear from cursor down (CSI J) but NOT clear scrollback (CSI 3J).
		expect(output).toContain('\x1b[J')
		expect(output).not.toContain('\x1b[3J')
	})

	test('force repaint in full mode clears scrollback', () => {
		setFullscreen(true)
		const frame = ['line 1', '> ']

		captureOutput(() => paint(frame))
		const output = captureOutput(() => paint(frame, { force: true }))

		expect(output).toContain('\x1b[3J')
	})

	test('fullscreen flag is one-way', () => {
		const originalRows = process.stdout.rows
		Object.defineProperty(process.stdout, 'rows', { value: 3, configurable: true })

		try {
			// Frame with 4 lines exceeds 3-row terminal.
			const bigFrame = ['a', 'b', 'c', 'd']
			captureOutput(() => paint(bigFrame))

			// Now paint a small frame -- fullscreen should stick.
			const smallFrame = ['x', '> ']
			const output = captureOutput(() => paint(smallFrame, { force: true }))

			expect(output).toContain('\x1b[3J')
		} finally {
			Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
		}
	})

	test('writes ALL lines on force repaint', () => {
		const frame = ['one', 'two', 'three', 'four', 'five', 'tabs', 'sep', '> ']

		captureOutput(() => paint(frame))
		const output = captureOutput(() => paint(frame, { force: true }))
		const clean = stripAnsi(output)

		for (const line of frame) {
			expect(clean).toContain(line)
		}
	})
})
