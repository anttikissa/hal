import { test, expect, beforeEach, afterEach } from 'bun:test'
import { saveMultilinePaste, cleanPaste, resetPasteCounter } from './clipboard.ts'
import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'

const PASTE_DIR = '/tmp/hal/paste'

beforeEach(() => {
	if (existsSync(PASTE_DIR)) rmSync(PASTE_DIR, { recursive: true })
	resetPasteCounter()
})
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

test('cleanPaste wraps dragged image path in brackets', () => {
	// Use a file we know exists
	const result = cleanPaste('/bin/ls.png')
	// Doesn't exist with .png, so no wrapping
	expect(result).toBe('/bin/ls.png')
})

test('cleanPaste wraps existing image path in brackets', async () => {
	const dir = '/tmp/hal/test-drag'
	mkdirSync(dir, { recursive: true })
	writeFileSync(`${dir}/photo.png`, 'fake png')
	try {
		expect(cleanPaste(`${dir}/photo.png`)).toBe(`[${dir}/photo.png]`)
		expect(cleanPaste(`${dir}/photo.png\n`)).toBe(`[${dir}/photo.png]`)
		// With spaces around it — still just a path
		expect(cleanPaste(`  ${dir}/photo.png  `)).toBe(`[${dir}/photo.png]`)
	} finally {
		rmSync(dir, { recursive: true })
	}
})

test('cleanPaste wraps jpg/jpeg/gif/webp paths too', () => {
	const dir = '/tmp/hal/test-drag2'
	mkdirSync(dir, { recursive: true })
	for (const ext of ['jpg', 'jpeg', 'gif', 'webp']) {
		writeFileSync(`${dir}/img.${ext}`, 'fake')
		expect(cleanPaste(`${dir}/img.${ext}`)).toBe(`[${dir}/img.${ext}]`)
	}
	rmSync(dir, { recursive: true })
})
