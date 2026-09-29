import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { drafts } from '../common/drafts.ts'
import type { Event, Snapshot } from '../common/protocol.ts'
import { settings } from '../common/settings.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { clipboard } from './clipboard.ts'
import type { KeyEvent } from './keys.ts'
import { render } from './render.ts'

// The terminal app with a recording link and a fake clipboard: pasted
// images and long texts go up as attachments and come back as markers.

let sent: any[] = []
let clip: { text?: string; image?: Uint8Array } = {}
let dir = ''
const saved = { send: app.send, show: render.show, draftSend: drafts.send, read: clipboard.read, image: clipboard.image }

beforeEach(() => {
	sent = []
	clip = {}
	dir = mkdtempSync(`${tmpdir()}/hal-paste-`)
	app.reset()
	settings.state.raw = {}
	app.send = (c) => void sent.push(c)
	drafts.send = (c: any) => void (c.type === 'draft' || sent.push(c))
	render.show = () => {}
	clipboard.read = async () => ({ text: clip.text ?? '' })
	clipboard.image = async () => clip.image ?? null
})

afterEach(() => {
	Object.assign(app, { send: saved.send })
	Object.assign(clipboard, { read: saved.read, image: saved.image })
	drafts.send = saved.draftSend
	render.show = saved.show
	app.reset()
	rmSync(dir, { recursive: true, force: true })
})

const snapshot = (id = 's1'): Event => {
	let snap: Snapshot = { meta: { id, cwd: '/', model: 'anthropic/x', createdAt: '' }, history: [], state: { type: 'idle' } }
	return { type: 'snapshot', sessionId: id, snapshot: snap }
}
const key = (key: string, text?: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({ key, text, shift: false, alt: false, ctrl: false, cmd: false, ...mods })
const type = (s: string) => app.onKeys([...s].map((c) => key(c, c)))
const text = () => appView.view().prompt.text
const attaches = () => sent.filter((c) => c.type === 'attach')
const submits = () => sent.filter((c) => c.type === 'submit').map((c) => c.text)
const tick = () => new Promise((r) => setTimeout(r, 0))
const attached = (command: string, marker: string): Event => ({ type: 'attached', sessionId: 's1', command, blob: 'b', marker })
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

async function pasteImage(): Promise<{ id: string; placeholder: string }> {
	clip = { image: png }
	app.onKeys([key('v', undefined, { ctrl: true })])
	await tick()
	let c = attaches().at(-1)
	let placeholder = text().match(/\[image\/[0-9a-z]{6}\.png\]/)![0]
	return { id: c.id, placeholder }
}

test('Ctrl-V with an image uploads it under the name its final marker shows', async () => {
	app.onEvent(snapshot())
	type('see ')
	let { id, placeholder } = await pasteImage()
	let name = placeholder.slice(7, -1)
	expect(attaches()).toEqual([{ type: 'attach', id, sessionId: 's1', mediaType: 'image/png', data: Buffer.from(png).toString('base64'), name }])
	type(' and')
	app.onEvent(attached(id, placeholder))
	expect(text()).toBe(`see ${placeholder} and`)
	expect(drafts.text('s1')).toBe(text())
})

test('a host that answers at once (the host process’s own terminal) still gets its placeholder replaced', async () => {
	app.onEvent(snapshot())
	// The in-memory connection delivers `attached` inside send().
	app.send = (c: any) => {
		sent.push(c)
		if (c.type === 'attach') app.onEvent(attached(c.id, '[paste 0123456789ab, 8 lines]'))
	}
	app.onKeys([key('paste', Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n'))])
	await tick()
	expect(text()).toBe('[paste 0123456789ab, 8 lines]')
	app.onKeys([key('enter')])
	expect(submits()).toEqual(['[paste 0123456789ab, 8 lines]'])
})

test('a refused upload leaves an error text in place of the placeholder', async () => {
	app.onEvent(snapshot())
	let { id, placeholder } = await pasteImage()
	app.onEvent({ type: 'rejected', sessionId: 's1', command: 'attach', reason: 'attachment is not image/png', id })
	expect(text()).not.toContain(placeholder)
	expect(text()).toContain('attachment is not image/png')
})

test('Enter during an upload waits, then sends the prompt with the marker', async () => {
	app.onEvent(snapshot())
	type('look ')
	let { id, placeholder } = await pasteImage()
	app.onKeys([key('enter')])
	expect(submits()).toEqual([])
	app.onEvent(attached(id, placeholder))
	expect(submits()).toEqual([`look ${placeholder}`])
	expect(text()).toBe('')
})

test('clipboard text wins over an image, and pastes as text', async () => {
	app.onEvent(snapshot())
	clip = { text: 'plain', image: png }
	app.onKeys([key('v', undefined, { ctrl: true })])
	await tick()
	expect(text()).toBe('plain')
	expect(attaches()).toEqual([])
})

test('a pasted path of an existing image file attaches the file; other paths stay text', async () => {
	writeFileSync(`${dir}/shot one.png`, png)
	app.onEvent(snapshot())
	app.onKeys([key('paste', `${dir}/shot\\ one.png`)])
	await tick()
	expect(attaches()).toMatchObject([{ mediaType: 'image/png', data: Buffer.from(png).toString('base64') }])
	expect(text()).toBe(`[image/${attaches()[0].name}]`)
	app.onKeys([key('paste', ` ${dir}/missing.png`)])
	await tick()
	expect(attaches()).toHaveLength(1)
	expect(text()).toEndWith(`${dir}/missing.png`)
})

test('several dropped files: images and text files attach, other paths stay as typed; text with spaces is never split', async () => {
	writeFileSync(`${dir}/shot one.png`, png)
	writeFileSync(`${dir}/notes.md`, '# hi')
	writeFileSync(`${dir}/song.s3m`, new Uint8Array([0, 1, 2]))
	app.onEvent(snapshot())
	app.onKeys([key('paste', `${dir}/notes.md ${dir}/song.s3m ${dir}/shot\\ one.png`)])
	await tick()
	expect(attaches().map((c) => c.mediaType)).toEqual(['text/plain', 'application/octet-stream', 'image/png'])
	expect(Buffer.from(attaches()[0].data, 'base64').toString()).toBe('# hi')
	expect(text()).toBe(`[paste/${attaches()[0].name}] [file/${attaches()[1].name}] [image/${attaches()[2].name}]`)
	app.onKeys([key('paste', ` ${dir}/shot\\ one.png is not ${dir}/notes.md`)])
	await tick()
	expect(attaches()).toHaveLength(3)
	expect(text()).toEndWith(`${dir}/shot\\ one.png is not ${dir}/notes.md`)
})

test('a dropped text file attaches like the web drop; one that is not UTF-8 stays a path', async () => {
	writeFileSync(`${dir}/README`, 'read me\n')
	writeFileSync(`${dir}/bad.txt`, new Uint8Array([0xff, 0xfe, 0x00]))
	app.onEvent(snapshot())
	app.onKeys([key('paste', `${dir}/README`)])
	await tick()
	expect(attaches()).toMatchObject([{ mediaType: 'text/plain' }])
	expect(text()).toBe(`[paste/${attaches()[0].name}]`)
	app.onKeys([key('paste', ` ${dir}/bad.txt`)])
	await tick()
	expect(attaches()).toHaveLength(1)
	expect(text()).toEndWith(`${dir}/bad.txt`)
})

test('a paste longer than the setting becomes a text attachment; a short one stays inline', async () => {
	app.onEvent(snapshot())
	let long = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\r\n')
	app.onKeys([key('paste', long)])
	await tick()
	let [c] = attaches()
	expect(c).toMatchObject({ mediaType: 'text/plain' })
	expect(Buffer.from(c.data, 'base64').toString()).toBe(long.replaceAll('\r\n', '\n'))
	let marker = `[paste/${c.name}]`
	expect(c.name).toMatch(/^[0-9a-z]{6}\.txt$/)
	expect(text()).toBe(marker)
	app.onEvent(attached(c.id, marker))
	expect(text()).toBe(marker)

	settings.state.raw = { pasteLines: 20 }
	app.onKeys([key('paste', `\n${long}`)])
	await tick()
	expect(attaches()).toHaveLength(1)
	expect(text()).toContain('line 7')
})

test('an image too large to send is not read or sent; an error text is pasted', () => {
	let big = `${dir}/big.png`
	writeFileSync(big, png)
	truncateSync(big, 6 * 1024 * 1024)
	app.onEvent(snapshot())
	app.onKeys([key('paste', big)])
	expect(attaches()).toEqual([])
	expect(text()).toContain('larger than 5 MB')
})
