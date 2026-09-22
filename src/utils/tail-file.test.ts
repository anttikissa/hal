import { describe, test, expect } from 'bun:test'
import { mkdtemp, appendFile } from 'fs/promises'
import { writeFileSync, appendFileSync, truncateSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tails } from './tail-file'
import { parseStream, stringify } from './ason'

const { tailFile } = tails

function tmpFile(name: string) {
	const p = join('/tmp', `tail-test-${name}-${Date.now()}.txt`)
	writeFileSync(p, '')
	return p
}

async function collect(stream: ReadableStream<Uint8Array>, count: number, timeout = 2000): Promise<string[]> {
	const reader = stream.getReader()
	const chunks: string[] = []
	const timer = setTimeout(() => reader.cancel(), timeout)
	try {
		while (chunks.length < count) {
			const { done, value } = await reader.read()
			if (done) break
			chunks.push(new TextDecoder().decode(value))
		}
	} finally {
		clearTimeout(timer)
		await reader.cancel()
	}
	return chunks
}

test('only gets future data (starts from EOF)', async () => {
	const p = tmpFile('eof')
	writeFileSync(p, 'old stuff')
	try {
		const stream = tailFile(p)
		const promise = collect(stream, 1)
		await Bun.sleep(100)
		appendFileSync(p, 'new stuff')
		const chunks = await promise
		expect(chunks.join('')).toBe('new stuff')
	} finally {
		unlinkSync(p)
	}
})

test.skip('handles truncation', async () => {
	const p = tmpFile('trunc')
	try {
		const stream = tailFile(p)
		const promise = collect(stream, 2)
		await Bun.sleep(100)
		appendFileSync(p, 'before')
		await Bun.sleep(100)
		truncateSync(p, 0)
		await Bun.sleep(50)
		appendFileSync(p, 'after')
		const chunks = await promise
		expect(chunks[0]).toBe('before')
		expect(chunks[1]).toBe('after')
	} finally {
		unlinkSync(p)
	}
})

test('stops promptly when canceled with no writes', async () => {
	const p = tmpFile('timeout')
	try {
		const stream = tailFile(p)
		const start = Date.now()
		const chunks = await collect(stream, 1, 200)
		const elapsed = Date.now() - start
		expect(chunks.length).toBe(0)
		expect(elapsed).toBeGreaterThanOrEqual(150)
		expect(elapsed).toBeLessThan(1000)
	} finally {
		unlinkSync(p)
	}
})

test('creates file if missing', async () => {
	const p = join('/tmp', `tail-test-missing-${Date.now()}.txt`)
	try {
		const stream = tailFile(p)
		const promise = collect(stream, 1)
		await Bun.sleep(100)
		appendFileSync(p, 'created')
		const chunks = await promise
		expect(chunks.join('')).toBe('created')
	} finally {
		unlinkSync(p)
	}
})

test('does not duplicate or drop records under burst appends', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'hal-tail-'))
	const file = join(dir, 'events.asonl')

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

	await Bun.sleep(100)

	await Promise.all(Array.from({ length: 200 }, (_, i) => appendFile(file, stringify({ n: i }, 'short') + '\n')))

	await readerTask

	expect(received.length).toBe(200)
	const sorted = [...received].sort((a, b) => a - b)
	expect(sorted[0]).toBe(0)
	expect(sorted[199]).toBe(199)
	expect(new Set(received).size).toBe(200)
})
