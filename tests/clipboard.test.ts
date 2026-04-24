import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clipboard } from '../src/cli/clipboard.ts'

let dir = ''

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'hal-clip-'))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe('clipboard', () => {
	test('wraps image file paths in brackets', () => {
		const path = join(dir, 'image.png')
		writeFileSync(path, 'x')
		expect(clipboard.cleanPaste(path)).toBe(`[${path}]`)
	})

	test('keeps multiline text inline', () => {
		const text = 'a\n'.repeat(6)
		expect(clipboard.cleanPaste(text)).toBe(text)
	})
})
