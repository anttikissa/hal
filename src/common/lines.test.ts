import { expect, test } from 'bun:test'
import { lines } from './lines.ts'

function collect(maxLine?: number) {
	let values: unknown[] = []
	let errors: string[] = []
	let feed = lines.decoder(
		(v) => values.push(v),
		(e) => errors.push(e.message),
		maxLine,
	)
	return { feed, values, errors }
}

const messages = [
	{ type: 'submit', sessionId: '1-abc', text: 'two\nlines and a ✓ and 🙂' },
	{ type: 'stream', event: { type: 'text', text: "it's \"quoted\"\r\n" } },
	{ n: [1, 2.5, -3], nested: { empty: [], none: null } },
]

test('messages split at every byte boundary decode unchanged', () => {
	let bytes = new TextEncoder().encode(messages.map((m) => lines.encode(m)).join(''))
	for (let cut = 1; cut < bytes.length; cut++) {
		let c = collect()
		c.feed(bytes.slice(0, cut))
		c.feed(bytes.slice(cut))
		expect(c.values).toEqual(messages)
		expect(c.errors).toEqual([])
	}
})

test('a message arrives only once its line is complete', () => {
	let c = collect()
	let line = lines.encode(messages[0])
	c.feed(line.slice(0, -1))
	expect(c.values).toEqual([])
	c.feed('\n')
	expect(c.values).toEqual([messages[0]])
})

test('a bad line is reported and the next one still decodes', () => {
	let c = collect()
	c.feed(`{ oops\n\n${lines.encode({ ok: 1 })}`)
	expect(c.errors.length).toBe(1)
	expect(c.values).toEqual([{ ok: 1 }])
})

test('an overlong line is dropped without buffering it all', () => {
	let c = collect(100)
	c.feed(`'${'x'.repeat(60)}`)
	c.feed(`${'x'.repeat(60)}`)
	expect(c.errors.length).toBe(1)
	c.feed(`${'x'.repeat(500)}'\n`)
	c.feed(lines.encode({ ok: 2 }))
	expect(c.errors.length).toBe(1)
	expect(c.values).toEqual([{ ok: 2 }])
})
