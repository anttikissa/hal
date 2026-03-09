import { test, expect, beforeEach, afterEach } from 'bun:test'
import { saveMultilinePaste, cleanPaste } from './clipboard.ts'
import { rmSync, readFileSync, existsSync } from 'fs'

const PASTE_DIR = '/tmp/hal/paste'

beforeEach(() => { if (existsSync(PASTE_DIR)) rmSync(PASTE_DIR, { recursive: true }) })
afterEach(() => { if (existsSync(PASTE_DIR)) rmSync(PASTE_DIR, { recursive: true }) })

test('saveMultilinePaste writes file and returns [path]', () => {
	const result = saveMultilinePaste('line1\nline2\nline3')
	expect(result).toMatch(/^\[\/tmp\/hal\/paste\/\d{4}\.txt\]$/)
	const path = result.slice(1, -1)
	expect(readFileSync(path, 'utf8')).toBe('line1\nline2\nline3')
})

test('saveMultilinePaste increments file number', () => {
	const r1 = saveMultilinePaste('a\nb')
	const r2 = saveMultilinePaste('c\nd')
	expect(r1).toContain('0001.txt')
	expect(r2).toContain('0002.txt')
})

test('cleanPaste normalizes line endings and strips control chars', () => {
	expect(cleanPaste('a\r\nb\rc')).toBe('a\nb\nc')
	expect(cleanPaste('hello\x00world\x07!')).toBe('helloworld!')
	// newlines and tabs preserved
	expect(cleanPaste('a\tb\n')).toBe('a\tb\n')
})

test('cleanPaste returns inline text for ≤5 newlines', () => {
	const text = 'a\nb\nc\nd\ne\nf'  // 5 newlines
	expect(cleanPaste(text)).toBe(text)
})

test('cleanPaste saves to file for >5 newlines', () => {
	const text = 'a\nb\nc\nd\ne\nf\ng'  // 6 newlines
	const result = cleanPaste(text)
	expect(result).toMatch(/^\[\/tmp\/hal\/paste\/\d{4}\.txt\]$/)
	const path = result.slice(1, -1)
	expect(readFileSync(path, 'utf8')).toBe(text)
})
