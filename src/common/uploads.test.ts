import { beforeEach, expect, test } from 'bun:test'
import type { Event } from './protocol.ts'
import { settings } from './settings.ts'
import { uploads } from './uploads.ts'

beforeEach(() => {
	uploads.reset()
	settings.state.raw = {}
})

const attached = (command: string, marker: string): Event => ({ type: 'attached', sessionId: 's', command, blob: 'b', marker })
const rejected = (id: string, reason: string): Event => ({ type: 'rejected', sessionId: 's', command: 'attach', reason, id })

test('the placeholder becomes the marker; the caret after it moves with the text', () => {
	let placeholder = uploads.begin('s', 'c.1', 'image/png')
	expect(uploads.command('s', 'c.1', 'image/png', new Uint8Array([1, 2]))).toEqual({ type: 'attach', id: 'c.1', sessionId: 's', mediaType: 'image/png', data: 'AQI=' })
	// Typed around after the paste: the caret is now past it.
	let text = `look ${placeholder} here and more`
	let p = { text, cursor: text.length, anchor: 2 }
	let done = uploads.settle(attached('c.1', '[image 0123456789ab]'))!
	expect(done.sessionId).toBe('s')
	let out = uploads.swap(p, done.placeholder, done.text)
	expect(out.text).toBe('look [image 0123456789ab] here and more')
	expect(out.cursor).toBe(out.text.length)
	expect(out.anchor).toBe(2)
	expect(uploads.pending('s')).toBe(false)
})

test('two uploads with the same kind get their own placeholders', () => {
	let a = uploads.begin('s', 'c.1', 'image/png')
	let b = uploads.begin('s', 'c.2', 'image/png')
	expect(a).not.toBe(b)
	let second = uploads.settle(attached('c.2', '[image bbbbbbbbbbbb]'))!
	expect(uploads.swap({ text: `${a} ${b}`, cursor: 0 }, second.placeholder, second.text).text).toBe(`${a} [image bbbbbbbbbbbb]`)
})

test('a refused upload leaves an error text, and answers not about uploads are ignored', () => {
	let placeholder = uploads.begin('s', 'c.1', 'image/png')
	expect(uploads.settle(rejected('c.9', 'no'))).toBeUndefined()
	let done = uploads.settle(rejected('c.1', 'attachment larger than 5 MB'))!
	expect(done.error).toBe('attachment larger than 5 MB')
	let out = uploads.swap({ text: placeholder, cursor: 3 }, done.placeholder, done.text).text
	expect(out).toContain('attachment larger than 5 MB')
	expect(out).not.toContain(placeholder)
	expect(uploads.settle(rejected('c.1', 'again'))).toBeUndefined()
})

test('a submit waits for every upload of its session, and not after a failure', () => {
	uploads.begin('s', 'c.1', 'image/png')
	uploads.begin('s', 'c.2', 'image/png')
	uploads.wait('s', true)
	expect(uploads.settle(attached('c.1', '[image aaaaaaaaaaaa]'))!.resume).toBeUndefined()
	expect(uploads.settle(attached('c.2', '[image bbbbbbbbbbbb]'))!.resume).toEqual({ queue: true })

	uploads.begin('s', 'c.3', 'image/png')
	uploads.wait('s')
	expect(uploads.settle(rejected('c.3', 'bad'))!.resume).toBeUndefined()
	uploads.begin('s', 'c.4', 'image/png')
	expect(uploads.settle(attached('c.4', '[image cccccccccccc]'))!.resume).toBeUndefined()
})

test('a paste over the configured number of lines is long', () => {
	expect(uploads.long('1\n2\n3\n4\n5\n6\n7')).toBe(false)
	expect(uploads.long('1\n2\n3\n4\n5\n6\n7\n8')).toBe(true)
	settings.state.raw = { pasteLines: 2 }
	expect(uploads.long('1\n2\n3')).toBe(true)
})

test('only what the host may take is sent', () => {
	expect(uploads.tooBig(5 * 1024 * 1024)).toBeUndefined()
	expect(uploads.tooBig(5 * 1024 * 1024 + 1)).toContain('5 MB')
})

test('base64 matches the platform encoder, beyond one chunk', () => {
	let bytes = new Uint8Array(100_000).map((_, i) => (i * 7) & 255)
	expect(uploads.base64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
})
