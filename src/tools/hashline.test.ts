import { describe, test, expect } from 'bun:test'
import { hashline } from './hashline.ts'

const { hashLine, formatHashlines, parseRef, validateRef, formatContext, toLines } = hashline

describe('hashline', () => {
	test('hashLine returns 3-char string', () => {
		const h = hashLine('hello world')
		expect(h).toHaveLength(3)
		expect(h).toMatch(/^[0-9a-zA-Z]{3}$/)
	})

	test('hashLine is deterministic', () => {
		expect(hashLine('foo')).toBe(hashLine('foo'))
	})

	test('hashLine normalizes whitespace', () => {
		expect(hashLine('  hello  world  ')).toBe(hashLine('hello world'))
		expect(hashLine('\thello\tworld')).toBe(hashLine('hello world'))
	})

	test('hashLine differs for different content', () => {
		expect(hashLine('foo')).not.toBe(hashLine('bar'))
	})

	test('parseRef parses valid refs', () => {
		expect(parseRef('1:abc')).toEqual({ line: 1, hash: 'abc' })
		expect(parseRef('42:aZ9')).toEqual({ line: 42, hash: 'aZ9' })
	})

	test('parseRef rejects invalid refs', () => {
		expect(parseRef('1:ab')).toBeNull()
		expect(parseRef('x:abc')).toBeNull()
		expect(parseRef('1:abcd')).toBeNull()
		expect(parseRef('1-abc')).toBeNull()
	})

	test('formatHashlines prefixes each line', () => {
		const out = formatHashlines('a\nb\n')
		const lines = out.split('\n')
		expect(lines).toHaveLength(2)
		expect(lines[0]).toBe(`1:${hashLine('a')} a`)
		expect(lines[1]).toBe(`2:${hashLine('b')} b`)
	})

	test('formatHashlines with line range', () => {
		const out = formatHashlines('a\nb\nc\nd\n', 2, 3)
		const lines = out.split('\n')
		expect(lines).toHaveLength(2)
		expect(lines[0]).toContain('2:')
		expect(lines[0]).toContain(' b')
		expect(lines[1]).toContain('3:')
		expect(lines[1]).toContain(' c')
	})

	test('validateRef succeeds for correct hash', () => {
		const lines = ['alpha', 'beta', 'gamma']
		const ref = { line: 2, hash: hashLine('beta') }
		expect(validateRef(ref, lines)).toBeNull()
	})

	test('validateRef fails for wrong hash', () => {
		const lines = ['alpha', 'beta', 'gamma']
		const ref = { line: 2, hash: 'zzz' }
		expect(validateRef(ref, lines)).toContain('Hash mismatch')
	})

	test('validateRef fails for out of range', () => {
		const lines = ['alpha']
		const ref = { line: 5, hash: 'abc' }
		expect(validateRef(ref, lines)).toContain('out of range')
	})

	test('toLines drops trailing empty line', () => {
		expect(toLines('a\nb\n')).toEqual(['a', 'b'])
		expect(toLines('a\nb')).toEqual(['a', 'b'])
	})

	test('formatContext shows surrounding lines', () => {
		const lines = ['a', 'b', 'c', 'd', 'e']
		// Range is lines 2-3 (0-indexed: 1-3), context 1
		const result = formatContext(lines, 1, 3, 1)
		const outputLines = result.split('\n')
		// from=0 (1-1), to=4 (3+1)
		expect(outputLines).toHaveLength(4)
	})
})

describe('edit via hashline', () => {
	// Integration tests using the actual tool implementations
	const { executeEdit, executeWrite } = require('./write.ts').write
	const { execute: executeRead } = require('./read.ts').read
	const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('fs')
	const { join } = require('path')
	const { tmpdir } = require('os')

	let dir: string
	let file: string
	const ctx = { sessionId: 'test', cwd: '/tmp', signal: undefined }

	function setup(content: string) {
		dir = mkdtempSync(join(tmpdir(), 'hashline-'))
		file = join(dir, 'test.txt')
		writeFileSync(file, content)
		ctx.cwd = dir
	}

	function cleanup() {
		rmSync(dir, { recursive: true, force: true })
	}

	test('replace a single line', async () => {
		setup('alpha\nbeta\ngamma\n')
		const ref = `2:${hashLine('beta')}`
		const result = await executeEdit(
			{ path: file, operation: 'replace', start_ref: ref, end_ref: ref, new_content: 'BETA' },
			ctx,
		)
		expect(result).toContain('+++ after')
		expect(readFileSync(file, 'utf-8')).toBe('alpha\nBETA\ngamma\n')
		cleanup()
	})

	test('replace a range', async () => {
		setup('a\nb\nc\nd\n')
		const startRef = `2:${hashLine('b')}`
		const endRef = `3:${hashLine('c')}`
		const result = await executeEdit(
			{ path: file, operation: 'replace', start_ref: startRef, end_ref: endRef, new_content: 'X\nY' },
			ctx,
		)
		expect(result).toContain('+++ after')
		expect(readFileSync(file, 'utf-8')).toBe('a\nX\nY\nd\n')
		cleanup()
	})

	test('delete lines with empty new_content', async () => {
		setup('a\nb\nc\nd\n')
		const startRef = `2:${hashLine('b')}`
		const endRef = `3:${hashLine('c')}`
		const result = await executeEdit(
			{ path: file, operation: 'replace', start_ref: startRef, end_ref: endRef, new_content: '' },
			ctx,
		)
		expect(result).toContain('+++ after')
		expect(readFileSync(file, 'utf-8')).toBe('a\nd\n')
		cleanup()
	})

	test('insert after a line', async () => {
		setup('a\nb\n')
		const ref = `1:${hashLine('a')}`
		const result = await executeEdit(
			{ path: file, operation: 'insert', after_ref: ref, new_content: 'mid' },
			ctx,
		)
		expect(result).toContain('+++ after')
		expect(readFileSync(file, 'utf-8')).toBe('a\nmid\nb\n')
		cleanup()
	})

	test('insert at beginning with 0:000', async () => {
		setup('a\nb\n')
		const result = await executeEdit(
			{ path: file, operation: 'insert', after_ref: '0:000', new_content: 'top' },
			ctx,
		)
		expect(result).toContain('+++ after')
		expect(readFileSync(file, 'utf-8')).toBe('top\na\nb\n')
		cleanup()
	})

	test('rejects stale hash', async () => {
		setup('a\nb\nc\n')
		const ref = `2:${hashLine('b')}`
		// Modify file behind our back
		writeFileSync(file, 'a\nchanged\nc\n')
		const result = await executeEdit(
			{ path: file, operation: 'replace', start_ref: ref, end_ref: ref, new_content: 'X' },
			ctx,
		)
		expect(result).toContain('Hash mismatch')
		expect(result).toContain('Re-read the file')
		cleanup()
	})

	test('rejects invalid operation', async () => {
		setup('a\n')
		const result = await executeEdit(
			{ path: file, operation: 'bogus', new_content: 'X' },
			ctx,
		)
		expect(result).toContain('unknown operation')
		cleanup()
	})

	test('preserves unicode and special chars', async () => {
		setup('  keep  \n\nö\n')
		const ref = `3:${hashLine('ö')}`
		const result = await executeEdit(
			{ path: file, operation: 'replace', start_ref: ref, end_ref: ref, new_content: '🙂' },
			ctx,
		)
		expect(result).toContain('+++ after')
		expect(readFileSync(file, 'utf-8')).toBe('  keep  \n\n🙂\n')
		cleanup()
	})
})
