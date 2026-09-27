import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { settings } from '../common/settings.ts'
import { config } from '../host/config.ts'
import { paths } from '../host/paths.ts'
import { web } from '../host/web.ts'
import { app } from './app.ts'
import { attach } from './attach.ts'

// The message box's attachments without a browser: `insert` puts text
// at a caret kept here, as the Composer does in the textarea.

const sessionId = '1-abc'
const meta = { id: sessionId, cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])
let sent: any[] = []
let caret = 0
const orig = { send: connection.send, connected: connection.connected, store: drafts.store, rewrite: app.rewrite }

beforeEach(() => {
	sent = []
	caret = 0
	app.reset()
	drafts.reset()
	settings.state.raw = {}
	connection.send = (c: any) => void sent.push(c)
	connection.connected = () => true
	drafts.store = { load: () => undefined, save: () => {} }
	app.onEvent({ type: 'snapshot', sessionId, snapshot: { meta, history: [], state: { type: 'idle' } } } as Event)
})

afterEach(() => {
	Object.assign(connection, { send: orig.send, connected: orig.connected })
	drafts.store = orig.store
	app.rewrite = orig.rewrite
	drafts.reset()
	app.reset()
})

const insert = (text: string) => {
	let t = app.state.text
	app.input(t.slice(0, caret) + text + t.slice(caret))
	caret += text.length
}
const type = (text: string) => insert(text)
const tick = () => new Promise((r) => setTimeout(r, 0))
const attaches = () => sent.filter((c) => c.type === 'attach')
const item = (b: Blob) => ({ kind: 'file', type: b.type, getAsFile: () => b })
const clip = (items: any[], text = '') => ({ items, getData: (t: string) => (t === 'text/plain' ? text : '') })

test('a pasted image shows its final marker at the caret at once and uploads under that name', async () => {
	type('ab')
	caret = 1
	expect(attach.paste(clip([{ kind: 'string', type: 'text/html', getAsFile: () => null }, item(new Blob([png], { type: 'image/png' }))]), insert)).toBe(true)
	let name = /^a\[image\/([0-9a-z]{6}\.png)\]b$/.exec(app.state.text)![1]
	await tick()
	let [c] = attaches()
	expect(c).toMatchObject({ sessionId, mediaType: 'image/png', data: Buffer.from(png).toString('base64'), name })
	app.onEvent({ type: 'attached', sessionId, command: c.id, blob: name!.slice(0, 6), marker: `[image/${name}]` })
	expect(app.state.text).toBe(`a[image/${name}]b`)
	expect(drafts.text(sessionId)).toBe(app.state.text)
})

test('a refused upload leaves an error text', async () => {
	attach.files([new Blob([png], { type: 'image/png' }), new Blob(['x'], { type: 'text/plain' })], insert)
	await tick()
	expect(attaches()).toHaveLength(1)
	app.onEvent({ type: 'rejected', sessionId, command: 'attach', reason: 'attachment is not image/png', id: attaches()[0].id })
	expect(app.state.text).not.toContain('[image/')
	expect(app.state.text).toContain('attachment is not image/png')
})

test('Send during an upload waits and goes with the marker', async () => {
	type('see ')
	attach.files([new Blob([png], { type: 'image/png' })], insert)
	app.send()
	expect(sent.filter((c) => c.type === 'submit')).toEqual([])
	expect(app.notice()).toBeTruthy()
	await tick()
	let marker = `[image/${attaches()[0].name}]`
	app.onEvent({ type: 'attached', sessionId, command: attaches()[0].id, blob: 'b', marker })
	expect(sent.find((c) => c.type === 'submit')).toMatchObject({ text: `see ${marker}` })
	expect(app.state.text).toBe('')
})

test('long pasted text becomes a text attachment; short text pastes natively', async () => {
	let long = Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n')
	expect(attach.paste(clip([], 'short\ntext'), insert)).toBe(false)
	expect(attach.paste(clip([], long), insert)).toBe(true)
	expect(app.state.text).toMatch(/^\[uploading paste [^\]]+\]$/)
	await tick()
	expect(Buffer.from(attaches()[0].data, 'base64').toString()).toBe(long)
	expect(attaches()[0].mediaType).toBe('text/plain')
})

test('an image too large to send is refused before reading it', () => {
	attach.files([new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' })], insert)
	expect(attaches()).toEqual([])
	expect(app.state.text).toContain('5 MB')
})

// What the page does on load (main.tsx): read the settings the host
// wrote into it. The host and page share `settings` here, so the host's
// config is dropped first.
async function loadPage(): Promise<void> {
	let html = await (await web.page()).text()
	config.reset()
	settings.load(/<script type="application\/json" id="settings">(.*?)<\/script>/s.exec(html)?.[1])
}

test('pasteLines from config.ason reaches the page and decides which paste attaches', async () => {
	let savedHome = process.env.HAL_HOME
	let home = mkdtempSync(`${tmpdir()}/hal-attach-`)
	process.env.HAL_HOME = home
	try {
		let three = 'a\nb\nc'
		config.init()
		await loadPage()
		expect(attach.paste(clip([], three), insert)).toBe(false)
		writeFileSync(paths.configFile(), '{ pasteLines: 2 }\n')
		config.init()
		await loadPage()
		expect(attach.paste(clip([], three), insert)).toBe(true)
		await tick()
		expect(Buffer.from(attaches()[0].data, 'base64').toString()).toBe(three)
	} finally {
		config.reset()
		if (savedHome === undefined) delete process.env.HAL_HOME
		else process.env.HAL_HOME = savedHome
		rmSync(home, { recursive: true, force: true })
	}
})
