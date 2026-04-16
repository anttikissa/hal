import { expect, test } from 'bun:test'
import { sessionEntry } from './entry.ts'

test('userText joins only text parts', () => {
	const entry = {
		type: 'user',
		parts: [
			{ type: 'text', text: 'hello' },
			{ type: 'image', blobId: 'blob-1' },
			{ type: 'text', text: ' world' },
		],
	} as any

	expect(sessionEntry.userText(entry)).toBe('hello world')
	expect(sessionEntry.userText(entry, ' ')).toBe('hello  world')
})

test('loadEntryBlob skips blob lookups when no blob id exists', () => {
	expect(sessionEntry.loadEntryBlob('s1', { type: 'assistant' } as any)).toBeNull()
})
