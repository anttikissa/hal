import { afterEach, expect, test } from 'bun:test'
import { closeSync, existsSync, mkdirSync, openSync, rmSync, truncateSync } from 'fs'
import { join } from 'path'
import './read.ts'
import { hashline } from './hashline.ts'
import { toolRegistry } from './tool.ts'
import { read } from './read.ts'

const TEST_DIR = '/tmp/hal-test-read'

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
})

function makeLine(n: number): string {
	return `line ${String(n).padStart(6, '0')} ${'x'.repeat(120)}`
}

async function writeLargeTextFile(path: string, lineCount: number): Promise<void> {
	mkdirSync(TEST_DIR, { recursive: true })
	const chunks: string[] = []

	for (let start = 1; start <= lineCount; start += 2000) {
		const lines: string[] = []
		const end = Math.min(lineCount, start + 1999)
		for (let n = start; n <= end; n++) lines.push(makeLine(n))
		chunks.push(lines.join('\n') + '\n')
	}

	await Bun.write(path, chunks.join(''))
}

function formatExpectedRange(start: number, end: number): string {
	const width = String(end).length
	const lines: string[] = []
	for (let n = start; n <= end; n++) {
		const line = makeLine(n)
		lines.push(`${String(n).padStart(width)}:${hashline.hashLine(line)} ${line}`)
	}
	return lines.join('\n')
}

test('registers the read tool', () => {
	expect(toolRegistry.getTool('read')?.name).toBe('read')
})

test('reads a selected range from a file over 20MB', async () => {
	const path = join(TEST_DIR, 'large.txt')
	await writeLargeTextFile(path, 160_000)

	const out = await read.execute({ path, start: 120_000, end: 120_002 }, { sessionId: 's', cwd: TEST_DIR })
	const expected = formatExpectedRange(120_000, 120_002)

	expect(out).toBe(expected)
})

test('rejects files over the 50MB cap', async () => {
	mkdirSync(TEST_DIR, { recursive: true })
	const path = join(TEST_DIR, 'too-large.txt')
	const fd = openSync(path, 'w')
	closeSync(fd)
	truncateSync(path, 50_000_001)

	const out = await read.execute({ path }, { sessionId: 's', cwd: TEST_DIR })
	expect(out).toBe('error: file too large (50000001 bytes)')
})

test('keeps truncated output at or below 1MB', async () => {
	mkdirSync(TEST_DIR, { recursive: true })
	const path = join(TEST_DIR, 'huge-line.txt')
	const line = 'a'.repeat(1_100_000)
	await Bun.write(path, line)

	const out = await read.execute({ path }, { sessionId: 's', cwd: TEST_DIR })
	const bytes = Buffer.byteLength(out, 'utf8')

	expect(out.endsWith('[… truncated]')).toBe(true)
	expect(bytes).toBeLessThanOrEqual(1_000_000)
})
