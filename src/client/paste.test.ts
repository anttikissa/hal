import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { drafts } from '../common/drafts.ts'
import type { Event, Snapshot } from '../common/protocol.ts'
import { settings } from '../common/settings.ts'
import { app } from './app.ts'
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
const text = () => app.view().prompt.text
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
	let placeholder = text().match(/\[uploading image [^\]]+\]/)![0]
	return { id: c.id, placeholder }
}

test('Ctrl-V with an image uploads it; the placeholder becomes the marker after typing moved on', async () => {
	app.onEvent(snapshot())
	type('see ')
	let { id } = await pasteImage()
	expect(attaches()).toEqual([{ type: 'attach', id, sessionId: 's1', mediaType: 'image/png', data: Buffer.from(png).toString('base64') }])
	type(' and')
	app.onKeys([key('home')])
	type('>')
	app.onEvent(attached(id, '[image 0123456789ab]'))
	expect(text()).toBe('>see [image 0123456789ab] and')
	expect(app.view().prompt.cursor).toBe(1)
	expect(drafts.text('s1')).toBe(text())
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
	let { id } = await pasteImage()
	app.onKeys([key('enter')])
	expect(submits()).toEqual([])
	expect(text()).toContain('look [uploading image')
	app.onEvent(attached(id, '[image 0123456789ab]'))
	expect(submits()).toEqual(['look [image 0123456789ab]'])
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

test('a pasted path of an existing image file attaches the file; other paths stay text', () => {
	writeFileSync(`${dir}/shot one.png`, png)
	app.onEvent(snapshot())
	app.onKeys([key('paste', `${dir}/shot\\ one.png`)])
	expect(attaches()).toMatchObject([{ mediaType: 'image/png', data: Buffer.from(png).toString('base64') }])
	expect(text()).toMatch(/^\[uploading image [^\]]+\]$/)
	app.onKeys([key('paste', ` ${dir}/missing.png`)])
	expect(attaches()).toHaveLength(1)
	expect(text()).toEndWith(`${dir}/missing.png`)
})

test('a paste longer than the setting becomes a text attachment; a short one stays inline', () => {
	app.onEvent(snapshot())
	let long = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\r\n')
	app.onKeys([key('paste', long)])
	let [c] = attaches()
	expect(c).toMatchObject({ mediaType: 'text/plain' })
	expect(Buffer.from(c.data, 'base64').toString()).toBe(long.replaceAll('\r\n', '\n'))
	expect(text()).toMatch(/^\[uploading paste [^\]]+\]$/)
	app.onEvent(attached(c.id, '[paste 0123456789ab, 8 lines]'))
	expect(text()).toBe('[paste 0123456789ab, 8 lines]')

	settings.state.raw = { pasteLines: 20 }
	app.onKeys([key('paste', `\n${long}`)])
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
