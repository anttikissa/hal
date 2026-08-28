import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clipboard } from '../src/client/terminal/clipboard.ts'
import { clientTransport } from '../src/client/transport.ts'

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

	test('uploads image bytes through a remote client transport', async () => {
		const original = clientTransport.io.uploadImage
		try {
			clientTransport.io.uploadImage = async (data) => {
				expect([...data]).toEqual([1, 2, 3])
				return '/srv/hal/state/uploads/clipboard.png'
			}
			expect(await clipboard.pasteImage(Buffer.from([1, 2, 3]))).toBe('[/srv/hal/state/uploads/clipboard.png]')
		} finally {
			clientTransport.io.uploadImage = original
		}
	})

	test('keeps multiline text inline', () => {
		const text = 'a\n'.repeat(6)
		expect(clipboard.cleanPaste(text)).toBe(text)
	})
})
