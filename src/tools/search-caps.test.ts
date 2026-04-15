import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { glob } from './glob.ts'
import { grep } from './grep.ts'

const TEST_DIR = '/tmp/hal-test-search-caps'

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
})

test('glob truncates large result sets well below 1MB', async () => {
	mkdirSync(TEST_DIR, { recursive: true })
	for (let i = 0; i < 4000; i++) {
		writeFileSync(`${TEST_DIR}/file-${String(i).padStart(4, '0')}.json`, '')
	}
	const out = await glob.execute({ pattern: '*.json', path: TEST_DIR }, { sessionId: 's', cwd: TEST_DIR })
	expect(out.endsWith('[… truncated]')).toBe(true)
	expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(20_000)
})

test('grep truncates large match sets well below 1MB', async () => {
	mkdirSync(TEST_DIR, { recursive: true })
	const lines: string[] = []
	for (let i = 0; i < 4000; i++) lines.push(`needle line ${i} ${'x'.repeat(80)}`)
	writeFileSync(`${TEST_DIR}/big.txt`, lines.join('\n') + '\n')
	const out = await grep.execute({ pattern: 'needle', path: TEST_DIR, maxResults: 4000 }, { sessionId: 's', cwd: TEST_DIR })
	expect(out.endsWith('[… truncated]')).toBe(true)
	expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(40_000)
})
