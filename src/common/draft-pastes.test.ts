import { expect, test } from 'bun:test'
import { draftPastes } from './draft-pastes.ts'
import { uploads } from './uploads.ts'

test('expand all draft pastes once, preserving other attachments, caret and newer edits', () => {
	let marker = '[paste/abcdef.txt]'
	let text = `${marker} [image/ghijkl.png] ${marker}`
	let p = draftPastes.create('session', text)
	expect(p.names).toEqual(['abcdef.txt'])
	expect(p.accept({ type: 'paste-text', sessionId: 'other', name: 'abcdef.txt', text: 'wrong' })).toBe(false)
	p.accept({ type: 'paste-text', sessionId: 'session', name: 'abcdef.txt', text: `first\n${marker}` })
	expect(p.hint(text).hint).toBe('Replace 2 paste markers with their contents (4 lines).')
	let draft = { text: `new ${text}`, cursor: text.length + 4, anchor: 0 }
	let expanded = p.expand(draft)
	expect(expanded).toEqual({ text: `new first\n${marker} [image/ghijkl.png] first\n${marker}`, cursor: 4 + 2 * (`first\n${marker}`).length + ' [image/ghijkl.png] '.length, anchor: 0 })
	expect(draft.text).toBe(`new ${text}`)
})

test('missing or failed paste text leaves the entire draft unchanged', () => {
	let draft = { text: '[paste/abcdef.txt] [paste/ghijkl.txt]', cursor: 0 }
	let p = draftPastes.create('session', draft.text)
	p.accept({ type: 'paste-text', sessionId: 'session', name: 'abcdef.txt', text: 'ready' })
	expect(typeof p.expand(draft)).toBe('string')
	p.accept({ type: 'paste-text', sessionId: 'session', name: 'ghijkl.txt', error: 'no paste ghijkl.txt' })
	expect(p.expand(draft)).toBe('no paste ghijkl.txt')
	expect(draft.text).toBe('[paste/abcdef.txt] [paste/ghijkl.txt]')
	expect(p.hint('plain text').invalid).toBe(true)
})

test('a pending upload is not fetched or expanded', () => {
	let marker = uploads.begin('pending-session', 'pending-paste', 'text/plain')
	try {
		let p = draftPastes.create('pending-session', marker)
		expect(p.names).toEqual([])
		expect(p.expand({ text: marker, cursor: marker.length })).toBe(`Wait for paste upload: ${marker}`)
	} finally { uploads.state.pending.delete('pending-paste') }
})
