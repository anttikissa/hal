import { expect, test } from 'bun:test'
import { processOutput } from './process-output.ts'

test('readLimited keeps small streams unchanged', async () => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('hello'))
			controller.close()
		},
	})

	const out = await processOutput.readLimited(stream, 20, '\n[… truncated]')

	expect(out.text).toBe('hello')
	expect(out.truncated).toBe(false)
})

test('readLimited caps by bytes and drains the rest by default', async () => {
	let pulled = 0
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled++
			if (pulled > 10) {
				controller.close()
				return
			}
			controller.enqueue(new TextEncoder().encode('abcdef'))
		},
	})

	const out = await processOutput.readLimited(stream, 30, '\n[… truncated]')

	expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(30)
	expect(out.text.endsWith('\n[… truncated]')).toBe(true)
	expect(out.truncated).toBe(true)
	expect(pulled).toBe(11)
})

test('readLimited can stop the producer when the cap is reached', async () => {
	let canceled = false
	let limited = false
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new TextEncoder().encode('abcdef'))
		},
		cancel() {
			canceled = true
		},
	})

	const out = await processOutput.readLimited(stream, 30, '\n[… truncated]', () => {
		limited = true
	})

	expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(30)
	expect(out.truncated).toBe(true)
	expect(limited).toBe(true)
	expect(canceled).toBe(true)
})
