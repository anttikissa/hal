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

	test('removes DEL and C1 controls from pasted text', () => {
		expect(clipboard.cleanPaste('a\x7fb\u0085c\u009bd')).toBe('abcd')
	})
})
