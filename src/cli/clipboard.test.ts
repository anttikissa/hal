import { test, expect, beforeEach, afterEach } from 'bun:test'
import { saveMultilinePaste } from './clipboard.ts'
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
