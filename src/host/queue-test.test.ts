import { afterAll, expect, test } from 'bun:test'
import { queueTest } from './queue-test.ts'

queueTest.thinkMs = 0
afterAll(() => { queueTest.thinkMs = 4000 })

const user = (text: string) => ({ type: 'user', blocks: [{ type: 'text', text }], ts: '2026-10-06T11:34:00Z' })
const round = (n: number) => [
	{ type: 'assistant', block: { type: 'tool_call', id: `c${n}`, name: 'bash', input: {} } },
	{ type: 'user', blocks: [{ type: 'tool_result', id: `c${n}`, output: 'ok' }] },
]
const rounds = (n: number) => Array.from({ length: n }, (_, i) => round(i + 1)).flat()
const run = (...records: any[]) => queueTest.run(records)
async function text(reply: ReturnType<typeof queueTest.run>): Promise<string> {
	if (reply.say) return reply.say
	let t = ''
	for await (let e of reply.stream!) if (e.type === 'text') t += e.text
	return t
}

test('hal/queue-test: a number means that many more rounds, from the round it arrives in', async () => {
	expect(run(user('go 2'), ...rounds(1)).say).toBeUndefined()
	expect(run(user('go 2'), ...rounds(2)).say).toContain('Finished 2 rounds.')
	// Sent during round 1: rounds 2 and 3 remain.
	expect(await text(run(user('go'), ...round(1), user('2')))).toContain('OK: 2 rounds left, ending after round 3.')
	expect(run(user('go'), ...round(1), user('2'), ...round(2), ...round(3)).say).toContain('Finished 3 rounds.')
	// Only a message that is just a number counts after the prompt.
	expect(run(user('go 1'), ...round(1), user('not 5 rounds')).say).toContain('Finished 1 round.')
})

test("hal/queue-test: 'stop' ends the turn at the next round", () => {
	expect(run(user('go'), ...round(1), user('stop')).say).toContain('Stopped after 1 round, as asked.')
})
