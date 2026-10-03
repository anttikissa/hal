// Attachments end to end on the host (task 2a): attach, the marker in a
// prompt, history, provider bodies, and what clients see.

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { attachments } from '../common/attachments.ts'
import { anthropic } from './anthropic.ts'
import { blobs } from './blobs.ts'
import { calls, client, created, fresh, until, useHost, shown } from './host-fixture.test.ts'
import { history } from './history.ts'
import { openaiCompat } from './openai-compat.ts'
import { paths } from './paths.ts'

useHost()

// A tiny but real-looking png: the signature, then arbitrary bytes.
const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('IHDR-and-some-pixels')])
const png64 = png.toString('base64')

function attach(c: ReturnType<typeof client>, sessionId: string, mediaType: string, data: string, id: string = crypto.randomUUID(), name?: string) {
	c.conn.send({ type: 'attach', sessionId, mediaType, data, id, ...(name ? { name } : {}) })
	return { attached: c.of('attached').find((e) => e.command === id), rejected: c.of('rejected').find((e) => e.id === id) }
}

test('an attached png reaches both providers as an image; history keeps only its reference', async () => {
	let c = client()
	let id = created(c)
	let { attached } = attach(c, id, 'image/png', png64)
	expect(attached.marker).toBe(`[image ${attached.blob}]`)
	c.conn.send({ type: 'submit', sessionId: id, text: `what is in ${attached.marker}?` })
	await until(() => calls.length)
	let req = { model: 'm', ...calls[0]!.input }

	let sent = anthropic.toMessages(req).at(-1).content
	expect(sent[0].text).toContain('what is in')
	expect(sent[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png64 } })

	let chat: any = openaiCompat.toMessages(req).at(-1)
	expect(chat.content).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${png64}` } })

	let file = readFileSync(history.file(id), 'utf8')
	expect(file).not.toContain(png64)
	expect(file).toContain(attached.blob)
})

test('a paste becomes its text for the model', async () => {
	let c = client()
	let id = created(c)
	let text = 'line one\nline two\nline three\n'
	let { attached } = attach(c, id, 'text/plain', Buffer.from(text).toString('base64'))
	expect(attached.marker).toBe(`[paste ${attached.blob}, 3 lines]`)
	c.conn.send({ type: 'submit', sessionId: id, text: `summarise: ${attached.marker} thanks` })
	await until(() => calls.length)
	let prompt = JSON.stringify(calls[0]!.input.messages.at(-1))
	expect(prompt).toContain(JSON.stringify(`summarise: ${text} thanks`).slice(1, -1))
	expect(prompt).not.toContain('[paste')
})

test('a forged marker or another session’s blob stays text, and the sender is told', async () => {
	let c = client()
	let mine = created(c)
	let other = created(c)
	let { attached } = attach(c, other, 'image/png', png64)
	let forged = '[image 0123456789ab]'
	c.conn.send({ type: 'submit', sessionId: mine, text: `${attached.marker} ${forged} [paste ${attached.blob}, 1 line]` })
	await until(() => calls.length)
	let msg = calls[0]!.input.messages.at(-1)
	expect(msg.blocks.every((b: any) => b.type === 'text')).toBe(true)
	expect(msg.blocks[0].text).toContain(forged)
	expect(msg.blocks[0].text).toContain(attached.marker)
	let warning = c.of('warning').at(-1)
	expect(warning.text).toContain(forged)
	expect(warning.text).toContain(attached.marker)
})

test('attach refuses other types, fakes, oversize data and bad base64, storing nothing', () => {
	let c = client()
	let id = created(c)
	let bad = [
		['image/svg+xml', Buffer.from('<svg/>').toString('base64')],
		['image/png', Buffer.from('not a png at all').toString('base64')],
		['image/jpeg', png64],
		['image/png', 'not base64!'],
		['image/png', ''],
		['text/plain', Buffer.from([0xff, 0xfe, 0x00]).toString('base64')],
		['image/png', Buffer.concat([png, Buffer.alloc(attachments.maxBytes)]).toString('base64')],
	]
	for (let [type, data] of bad) {
		let { attached, rejected } = attach(c, id, type!, data!)
		expect(attached).toBeUndefined()
		expect(rejected.reason).toBeTruthy()
	}
	expect(() => readdirSync(blobs.dir(id))).toThrow()
})

test('a resent attach is answered again without storing twice', () => {
	let c = client()
	let id = created(c)
	let first = attach(c, id, 'image/png', png64, 'same')
	c.conn.send({ type: 'attach', sessionId: id, mediaType: 'image/png', data: png64, id: 'same' })
	let answers = c.of('attached').filter((e) => e.command === 'same')
	expect(answers).toHaveLength(2)
	expect(answers[1].blob).toBe(first.attached.blob)
	expect(readdirSync(blobs.dir(id))).toHaveLength(1)
})

test('image blocks show the same live and after reconnecting, and survive an edit', async () => {
	let c = client()
	let id = created(c)
	let { attached } = attach(c, id, 'image/png', png64)
	c.conn.send({ type: 'submit', sessionId: id, text: `see ${attached.marker}` })
	await until(() => calls.length)
	calls[0]!.push({ type: 'text', text: 'a cat' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)
	let image = { type: 'image' as const, blob: attached.blob as string, mediaType: 'image/png', bytes: png.length }
	expect(shown(c.views.get(id)!.items)).toContainEqual(image)
	expect((await fresh(id)).items).toEqual(c.views.get(id)!.items)

	c.conn.send({ type: 'submit', sessionId: id, text: `look again at ${attached.marker}`, amend: true })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.at(-1).blocks).toContainEqual(image)
	expect(c.views.get(id)!.items.filter((i) => i.type === 'image')).toHaveLength(1)
})

test('a named image waits in /tmp under its name; its prompt copies it into the session, which outlives /tmp', async () => {
	let c = client()
	let id = created(c)
	let name = attachments.newName('image/png')
	let { attached } = attach(c, id, 'image/png', png64, undefined, name)
	expect(attached.marker).toBe(`[image/${name}]`)
	let staged = `${paths.imageDir()}/${name}`
	expect(readFileSync(staged)).toEqual(png)
	expect(existsSync(blobs.dir(id))).toBe(false)

	c.conn.send({ type: 'submit', sessionId: id, text: `what is in [image/${name}]?` })
	await until(() => calls.length)
	expect(c.of('warning')).toEqual([])
	let blocks = calls[0]!.input.messages.at(-1).blocks
	expect(blocks[0].text).toEndWith(`what is in [image/${name}]?`)
	expect(blocks[1]).toMatchObject({ type: 'image', mediaType: 'image/png', bytes: png.length })
	expect(anthropic.toMessages({ model: 'm', ...calls[0]!.input }).at(-1).content[1].source.data).toBe(png64)
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)

	// /tmp cleaned: an edit keeps the image while its marker stays, and
	// drops it once the marker is deleted.
	rmSync(staged)
	c.conn.send({ type: 'submit', sessionId: id, text: `and now? [image/${name}]`, amend: true })
	await until(() => calls.length === 2)
	expect(calls[1]!.input.messages.at(-1).blocks).toContainEqual(blocks[1])
	expect(calls[1]!.input.image(blocks[1].blob)).toBe(png64)
	calls[1]!.push({ type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 2)
	c.conn.send({ type: 'submit', sessionId: id, text: 'never mind', amend: true })
	await until(() => calls.length === 3)
	expect(calls[2]!.input.messages.at(-1).blocks.some((b: any) => b.type === 'image')).toBe(false)
})

test('a named paste waits in /tmp as [paste/<name>]; its prompt gives the model the text and the session a copy', async () => {
	let c = client()
	let id = created(c)
	let text = 'line one\nline two\n'
	let name = attachments.newName('text/plain')
	let { attached } = attach(c, id, 'text/plain', Buffer.from(text).toString('base64'), undefined, name)
	expect(attached.marker).toBe(`[paste/${name}]`)
	expect(readFileSync(`${paths.fileDir(name)}/${name}`, 'utf8')).toBe(text)
	c.conn.send({ type: 'submit', sessionId: id, text: `summarise: ${attached.marker} thanks` })
	await until(() => calls.length)
	expect(c.of('warning')).toEqual([])
	expect(calls[0]!.input.messages.at(-1).blocks[0].text).toEndWith(`summarise: ${text} thanks`)
	expect(readFileSync(`${blobs.dir(id)}/${name}`, 'utf8')).toBe(text)
	expect(attach(c, id, 'text/plain', Buffer.from('other').toString('base64'), undefined, name).rejected.reason).toContain('taken')
})

test('a dropped .md keeps its extension; history and clients keep the marker, the model gets the text every round', async () => {
	let c = client()
	let id = created(c)
	let text = '# notes\n' + 'row\n'.repeat(1000)
	let name = attachments.newName('text/plain', 'notes.md')
	expect(name).toMatch(/^[0-9a-z]{6}\.md$/)
	expect(attachments.newName('text/plain', 'Makefile')).toMatch(/\.txt$/)
	let { attached } = attach(c, id, 'text/plain', Buffer.from(text).toString('base64'), undefined, name)
	expect(attached.marker).toBe(`[paste/${name}]`)
	c.conn.send({ type: 'submit', sessionId: id, text: `read ${attached.marker}` })
	await until(() => calls.length)
	// Transcripts and recall (both read history) show the marker.
	let saved = JSON.stringify(history.readSync(id).filter((r) => r.type === 'user'))
	expect(saved).toContain(`read ${attached.marker}`)
	expect(saved).not.toContain('row\\nrow')
	expect(calls[0]!.input.messages.at(-1).blocks[0].text).toEndWith(`read ${text}`)
	// Once /tmp is cleaned, the session's copy still gives the text.
	rmSync(`${paths.fileDir(name)}/${name}`)
	expect((await history.messages(id)).find((m) => m.role === 'user')!.blocks.some((b: any) => b.type === 'text' && b.text.endsWith(`read ${text}`))).toBe(true)
})


test('a named image is refused under a wrong name or a taken one; a resend of the same bytes is fine', () => {
	let c = client()
	let id = created(c)
	for (let name of ['abc123.jpg', 'ABC123.png', '../x12.png', 'abc1234.png', 'abc12.png']) {
		expect(attach(c, id, 'image/png', png64, undefined, name).rejected.reason).toBeTruthy()
	}
	let name = attachments.newName('image/png')
	expect(attach(c, id, 'image/png', png64, 'a', name).attached).toBeTruthy()
	expect(attach(c, id, 'image/png', png64, 'b', name).attached.marker).toBe(`[image/${name}]`)
	let other = Buffer.concat([png, Buffer.from('more')]).toString('base64')
	expect(attach(c, id, 'image/png', other, 'c', name).rejected.reason).toContain('taken')
	expect(readFileSync(`${paths.imageDir()}/${name}`)).toEqual(png)
})

test('an [image/<name>] marker whose file is gone, or is not an image, stays text and warns', async () => {
	let c = client()
	let id = created(c)
	mkdirSync(paths.imageDir(), { recursive: true })
	writeFileSync(`${paths.imageDir()}/fake01.png`, 'not a png')
	c.conn.send({ type: 'submit', sessionId: id, text: 'see [image/gone01.png] [image/fake01.png]' })
	await until(() => calls.length)
	expect(calls[0]!.input.messages.at(-1).blocks.every((b: any) => b.type === 'text')).toBe(true)
	expect(c.of('warning').at(-1).text).toContain('[image/gone01.png], [image/fake01.png]')
})
