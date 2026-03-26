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

test('picks up appended data', async () => {
	const p = tmpFile('append')
	try {
		const stream = tailFile(p)
		const promise = collect(stream, 1)
		await Bun.sleep(100)
		appendFileSync(p, 'hello')
		const chunks = await promise
		expect(chunks.join('')).toBe('hello')
	} finally {
		unlinkSync(p)
	}
})

test('multiple appends produce multiple chunks', async () => {
	const p = tmpFile('multi')
	try {
		const stream = tailFile(p)
		const promise = collect(stream, 3)
		await Bun.sleep(100)
		appendFileSync(p, 'one')
		await Bun.sleep(50)
		appendFileSync(p, 'two')
		await Bun.sleep(50)
		appendFileSync(p, 'three')
		const chunks = await promise
		expect(chunks.join('')).toBe('onetwothree')
	} finally {
		unlinkSync(p)
	}
})

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

test('handles truncation', async () => {
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

test('binary data works', async () => {
	const p = tmpFile('binary')
	try {
		const stream = tailFile(p)
		const promise = collect(stream, 1)
		await Bun.sleep(100)
		appendFileSync(p, new Uint8Array([0, 1, 2, 255, 254, 253]))
		const chunks = await promise
		expect(chunks.length).toBeGreaterThan(0)
	} finally {
		unlinkSync(p)
	}
})

test('large append (1MB)', async () => {
	const p = tmpFile('large')
	try {
		const stream = tailFile(p)
		let totalBytes = 0
		const reader = stream.getReader()
		await Bun.sleep(100)
		appendFileSync(p, 'x'.repeat(1024 * 1024))
		while (totalBytes < 1024 * 1024) {
			const { done, value } = await reader.read()
			if (done) break
			totalBytes += value.length
		}
		await reader.cancel()
		expect(totalBytes).toBe(1024 * 1024)
	} finally {
		unlinkSync(p)
	}
}, 10000)

test('rapid small appends', async () => {
	const p = tmpFile('rapid')
	try {
		const stream = tailFile(p)
		let all = ''
		const reader = stream.getReader()
		await Bun.sleep(100)
		for (let i = 0; i < 100; i++) {
			appendFileSync(p, `${i}\n`)
		}
		const deadline = Date.now() + 3000
		while (Date.now() < deadline) {
			const { done, value } = await reader.read()
			if (done) break
			all += new TextDecoder().decode(value)
			if (all.includes('99\n')) break
		}
		await reader.cancel()
		expect(all).toContain('0\n')
		expect(all).toContain('99\n')
	} finally {
		unlinkSync(p)
	}
}, 5000)

test('cancel stops the stream', async () => {
	const p = tmpFile('cancel')
	try {
		const stream = tailFile(p)
		const reader = stream.getReader()
		await Bun.sleep(100)
		appendFileSync(p, 'data')
		const { value } = await reader.read()
		expect(new TextDecoder().decode(value)).toBe('data')
		await reader.cancel()
	} finally {
		unlinkSync(p)
	}
})

test('stops promptly when cancelled with no writes', async () => {
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
