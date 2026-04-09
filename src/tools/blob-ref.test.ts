import { expect, test } from 'bun:test'
import { blobRef } from './blob-ref.ts'

test('parse uses current session for bare blob ids', () => {
	expect(blobRef.parse('0gdec4-bol', '04-whl')).toEqual({
		sessionId: '04-whl',
		blobId: '0gdec4-bol',
	})
})

test('parse accepts namespaced session/blob ids', () => {
	expect(blobRef.parse('04-fyx/0gdec4-bol', '04-whl')).toEqual({
		sessionId: '04-fyx',
		blobId: '0gdec4-bol',
	})
})

test('parse rejects malformed ids', () => {
	expect(blobRef.parse('', '04-whl')).toBeNull()
	expect(blobRef.parse('/', '04-whl')).toBeNull()
	expect(blobRef.parse('04-fyx/', '04-whl')).toBeNull()
	expect(blobRef.parse('/0gdec4-bol', '04-whl')).toBeNull()
	expect(blobRef.parse('04-fyx/0gdec4-bol/extra', '04-whl')).toBeNull()
})
