import { expect, test } from 'bun:test'
import { calls, client, created, until, useHost } from './host-fixture.test.ts'
import { push } from './push.ts'

useHost()

// Runs one turn in `id` that replies `text`, counting pushes meanwhile.
async function turn(c: ReturnType<typeof client>, id: string, text: string): Promise<number> {
	let pushed = 0
	let original = push.notify
	push.notify = async () => void pushed++
	try {
		let ends = c.of('turn-end').length
		c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
		await until(() => calls.length)
		calls.shift()!.push({ type: 'text', text }, { type: 'done', reason: 'end' })
		await until(() => c.of('turn-end').length > ends)
		await Bun.sleep(5)
	} finally {
		push.notify = original
	}
	return pushed
}

test('a turn end reaches the user once: nothing if watched, a notice if another tab is, else a push', async () => {
	let a = client(), b = client()
	let one = created(a), two = created(a)
	b.conn.send({ type: 'open', sessionId: one })

	// b watches the session itself: no notice anywhere, no push.
	b.conn.send({ type: 'visibility', sessionId: one, visible: true })
	a.conn.send({ type: 'visibility', sessionId: two, visible: true })
	expect(await turn(a, one, 'first')).toBe(0)
	expect(a.of('notice')).toEqual([])

	// Only another tab is watched: a notice there, with the reply's last line, and no push.
	b.conn.send({ type: 'visibility', sessionId: one, visible: false })
	expect(await turn(a, one, 'working on it\n\ntests pass, pushed to main\n')).toBe(0)
	expect(a.of('notice')).toMatchObject([{ session: one, kind: 'done', line: 'tests pass, pushed to main' }])
	expect(b.of('notice')).toEqual([])

	// Nobody watches: a push, no notice.
	a.conn.send({ type: 'visibility', sessionId: two, visible: false })
	expect(await turn(a, one, 'third')).toBe(1)
	expect(a.of('notice')).toHaveLength(1)
})

test("a reply's <summary> is its notice line", async () => {
	let a = client()
	let one = created(a), two = created(a)
	a.conn.send({ type: 'visibility', sessionId: two, visible: true })
	await turn(a, one, 'Deployed.\n\n<summary>Deploy to example.com finished in 15 s.</summary>\nthanks')
	expect(a.of('notice').at(-1)).toMatchObject({ line: 'Deploy to example.com finished in 15 s.' })
})
