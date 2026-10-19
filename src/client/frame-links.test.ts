// Frame tests for links: block ids, image and paste markers, and the
// OSC 8 targets they carry.

import { expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import { oklch, type Oklch } from '../common/oklch.ts'
import type { Shown as Item } from '../common/transcript.ts'
import { settings } from '../common/settings.ts'
import { uploads } from '../common/uploads.ts'
import { frame } from './frame.ts'
import { ansi } from './ansi.ts'
import { target } from '../web/target.ts'
import { plain, targets, view, useNames } from './frame-fixture.test.ts'

useNames()

// Where text in `style`'s quieter color starts (ansi.quiet).
const quietOn = (style: { fg?: Oklch; bg?: Oklch }) =>
	ansi.sgr({ fg: oklch.quiet(style.fg!, style.bg ?? colors.screen) })

test('every image returned by a tool remains linked, including consecutive images', () => {
	let images = ['0123456789ab', '0123456789ac'].map((blob): Item => ({
		type: 'image',
		blob,
		mediaType: 'image/png',
		bytes: 12,
	}))
	for (let cols of [40, 100]) {
		let output = frame
			.build(view([{ type: 'tool-result', id: 'r', output: 'images' }, ...images]), cols)
			.lines.join('\n')
		for (let image of images) if (image.type === 'image') expect(output).toContain(`/s/${image.blob}`)
	}
})

test('an [image/<name>] marker is a link to the image, in the transcript and the prompt; the text stays the same', () => {
	let url = `http://localhost:${settings.webPort()}/image/abc123.png`
	let link = `\x1b]8;;${url}\x07[image/abc123.png]\x1b]8;;\x07`
	let f = frame.build(view([{ type: 'prompt', text: 'see [image/abc123.png] ok' }], 'and [image/abc123.png]'), 60)
	let rows = f.lines.filter((l) => l.includes('[image/abc123.png]'))
	expect(rows).toHaveLength(2)
	for (let row of rows) expect(row).toContain(link)
	expect(plain(rows)).toEqual(['see [image/abc123.png] ok', 'and [image/abc123.png]'])
	// A forged name is not linked.
	expect(frame.build(view([{ type: 'prompt', text: '[image/../x.png]' }]), 60).lines.join('')).not.toMatch(
		/\x1b\]8;;[^\x07]*x\.png/,
	)
})

test('every block shows its id at the right of its first row, linked to the block on the web with the code hidden; a tool result and an item without a block id show none', () => {
	ansi.state.web = { url: 'https://h.example', code: 'k3x9qa' }
	try {
		let items: Item[] = [
			{ type: 'prompt', text: 'list files' },
			{ type: 'text', text: 'Looking.' },
			{ type: 'tool', id: 't1', name: 'bash', input: { command: 'ls' } },
			{ type: 'tool-result', id: 't1', output: 'a\nb' },
			{ type: 'question', id: 'q', form: { text: 'Delete?', fields: [] }, canceled: true },
			{ type: 'turn-end', status: 'error', error: 'boom' },
		]
		let v = view(items)
		v.transcript!.items = v.transcript!.items.map((it, i) => ({ ...it, key: ['4', '5', '6', '6.1', '7', '8'][i]! }))
		let lines = frame.build(v, 60).lines
		let links = targets(lines).map((u) => new URL(u))
		// Each resolves on the web to the card of that block (task 0z).
		let blocks = links.map((u) => target.parse(u.href, u.pathname.slice(1)))
		expect(blocks).toEqual(['4', '5', '6', '7', '8'].map((key) => ({ session: 's', key })))
		// The id is the link's text, at the right edge of the row.
		for (let key of ['u4', 'a5', 't6', 'q7', 's8'])
			expect(plain(lines).some((l) => l.endsWith(` ${key}`) && l.length === 58)).toBe(true)
		expect(plain(lines)).not.toContain('#6.1')
		for (let u of links) expect(u.searchParams.get('auth')).toBe('k3x9qa')
		let shown = lines.map((l) => l.replace(/\x1b\]8;;[^\x07]*\x07/g, ''))
		expect(shown.join('\n')).not.toContain('k3x9qa')
		expect(plain(lines).join('\n')).toContain('ls')
		expect(plain(lines).join('\n')).toContain('error: boom')
		// A streaming block's Hal cursor follows its text, not its id.
		let stream = view([{ type: 'text', text: 'Hel' }])
		stream.transcript!.items[0]!.key = '9'
		stream.hal = { at: 'stream', lit: true, color: colors.assistant().fg! }
		let streamed = plain(frame.build(stream, 60).lines)
		expect(streamed[0]).toBe('')
		expect(streamed[1]).toMatch(/^Hal +a9$/)
		expect(streamed[3]).toBe('Hel█')
		// A block still streaming before it has a number is not linked.
		let streaming = view([{ type: 'tool', id: 't2', name: 'bash', input: {} }])
		streaming.transcript!.items[0]!.key = '~0'
		expect(targets(frame.build(streaming, 60).lines)).toEqual([])
	} finally {
		ansi.state.web = { url: '', code: '' }
	}
})

test('a [paste/<name>] marker links to its page; while its upload is in flight it is quieter and no link, with the same text', () => {
	let marker = uploads.begin('s', 'c.1', 'text/plain')
	let path = marker.slice(1, -1)
	let build = () => frame.build(view([], `see ${marker}`), 60).lines.filter((l) => l.includes(marker))
	try {
		let flying = build()
		expect(flying.join('')).not.toContain('\x1b]8;')
		expect(flying.join('')).toContain(quietOn(colors.user()) + marker)
		uploads.settle({ type: 'attached', sessionId: 's', command: 'c.1', blob: 'b', marker })
		let landed = build()
		expect(landed.join('')).toContain(`\x1b]8;;http://localhost:${settings.webPort()}/${path}\x07${marker}\x1b]8;;\x07`)
		expect(plain(landed)).toEqual(plain(flying))
	} finally {
		uploads.reset()
	}
})
