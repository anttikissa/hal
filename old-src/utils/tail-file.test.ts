import { describe, test, expect } from 'bun:test'
import { mkdtemp, appendFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { tailFile } from './tail-file'
import { parseStream, stringify } from './ason'

describe('tailFile', () => {
	test('does not duplicate or drop records under burst appends', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hal-tail-'))
		const file = join(dir, 'events.asonl')
		await writeFile(file, '')

		const stream = tailFile(file)
		const received: number[] = []

		const readerTask = (async () => {
			for await (const event of parseStream(stream) as AsyncGenerator<any>) {
				if (event && typeof event.n === 'number') {
					received.push(event.n)
					if (received.length >= 200) break
				}
			}
		})()

		// Give tail -f a moment to start watching
		await Bun.sleep(100)

		// Burst writes in parallel to stress watcher callbacks.
		await Promise.all(
			Array.from({ length: 200 }, (_, i) => appendFile(file, stringify({ n: i }, 'short') + '\n')),
		)

		await readerTask

		expect(received.length).toBe(200)
		const sorted = [...received].sort((a, b) => a - b)
		expect(sorted[0]).toBe(0)
		expect(sorted[199]).toBe(199)
		expect(new Set(received).size).toBe(200)
	})
})
