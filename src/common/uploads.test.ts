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

test('an image is its final marker [image/<name>] from the start; the command carries the name', () => {
	let marker = uploads.begin('s', 'c.1', 'image/png')
	let name = /^\[image\/([0-9a-z]{6}\.png)\]$/.exec(marker)![1]
	expect(uploads.command('s', 'c.1', 'image/png', new Uint8Array([1, 2]))).toEqual({ type: 'attach', id: 'c.1', sessionId: 's', mediaType: 'image/png', data: 'AQI=', name })
	expect(uploads.begin('s', 'c.2', 'image/jpeg')).toMatch(/^\[image\/[0-9a-z]{6}\.jpg\]$/)
	expect(uploads.pending('s')).toBe(true)
	let done = uploads.settle(attached('c.1', marker))!
	expect(uploads.swap({ text: `look ${marker}`, cursor: 0 }, done.placeholder, done.text).text).toBe(`look ${marker}`)
})

test('a long paste is its final marker [paste/<name>.txt] from the start, in flight until answered', () => {
	let marker = uploads.begin('s', 'c.1', 'text/plain')
	let name = /^\[paste\/([0-9a-z]{6}\.txt)\]$/.exec(marker)![1]
	expect(uploads.command('s', 'c.1', 'text/plain', new Uint8Array([1, 2]))).toEqual({ type: 'attach', id: 'c.1', sessionId: 's', mediaType: 'text/plain', data: 'AQI=', name })
	expect(uploads.inFlight(marker)).toBe(true)
	let text = `look ${marker} here and more`
	let p = { text, cursor: text.length, anchor: 2 }
	let done = uploads.settle(attached('c.1', marker))!
	expect(done.sessionId).toBe('s')
	expect(uploads.swap(p, done.placeholder, done.text)).toEqual(p)
	expect(uploads.inFlight(marker)).toBe(false)
	expect(uploads.pending('s')).toBe(false)
})

test('a placeholder the host answers differently is swapped; the caret after it moves with the text', () => {
	let placeholder = uploads.begin('s', 'c.1', 'text/plain')
	// Typed around after the paste: the caret is now past it.
	let text = `look ${placeholder} here and more`
	let p = { text, cursor: text.length, anchor: 2 }
	let done = uploads.settle(rejected('c.1', 'too big'))!
	let out = uploads.swap(p, done.placeholder, done.text)
	expect(out.text).toBe('look [upload failed: too big] here and more')
	expect(out.cursor).toBe(out.text.length)
	expect(out.anchor).toBe(2)
})

test('two uploads of the same kind get their own placeholders', () => {
	for (let type of ['image/png', 'text/plain']) {
		let a = uploads.begin('s', 'c.1', type)
		let b = uploads.begin('s', 'c.2', type)
		expect(a).not.toBe(b)
	}
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
	uploads.wait('s', 'queue')
	expect(uploads.settle(attached('c.1', '[image aaaaaaaaaaaa]'))!.resume).toBeUndefined()
	expect(uploads.settle(attached('c.2', '[image bbbbbbbbbbbb]'))!.resume).toEqual({ delivery: 'queue' })

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

test('base64 matches the platform encoder, beyond one chunk', () => {
	let bytes = new Uint8Array(100_000).map((_, i) => (i * 7) & 255)
	expect(uploads.base64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
})
