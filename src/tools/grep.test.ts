import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { grep } from './grep.ts'

let root = ''

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hal-grep-tool-'))
	writeFileSync(join(root, 'one.txt'), 'hello world\nbye\n')
	writeFileSync(join(root, 'two.md'), 'hello markdown\n')
})

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
})

describe('grep tool', () => {
	test('args preview uses pattern', () => {
		expect(grep.argsPreview({ pattern: 'hello' })).toBe('hello')
	})

	test('execute finds matches and respects include glob', async () => {
		const result = await grep.execute(
			{ pattern: 'hello', path: root, include: '*.txt' },
			{ cwd: root },
		)
		expect(result).toContain('one.txt')
		expect(result).not.toContain('two.md')
	})
})
