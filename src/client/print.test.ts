import { expect, test } from 'bun:test'
import { connection } from '../common/connection.ts'
import type { Event } from '../common/protocol.ts'
import { print } from './print.ts'

async function harness(job: Parameters<typeof print.run>[0], check: (h: { run: ReturnType<typeof print.run>; sent: any[]; out: string[]; err: string[]; event(e: Event): void }) => Promise<void>) {
	let send = connection.send
	let sent: any[] = [], out: string[] = [], err: string[] = []
	connection.send = (c) => { sent.push(c) }
	try {
		let run = print.run(job, { out: (s) => out.push(s), err: (s) => err.push(s) })
		await check({ run, sent, out, err, event: run.onEvent })
	} finally { connection.send = send }
}

const tabs: Event = { type: 'tabs', tabs: [{ id: '07-bah', name: 'target', cwd: '/tmp', model: 'test', state: { type: 'idle' } }] }

test('print creates an autoclosing tab and returns a question with exit 3', async () => {
	await harness({ prompt: 'task', cwd: '/tmp' }, async ({ run, sent, event, out }) => {
		run.begin()
		expect(sent[0]).toMatchObject({ autoclose: true, interactive: false })
		event({ type: 'ack', id: sent[0].id, tab: '07-bah' })
		let prompt = sent.find((s) => s.type === 'submit')
		event({ type: 'turn-start', sessionId: '07-bah', provider: 'test', command: prompt.id })
		event({ type: 'stream', sessionId: '07-bah', event: { type: 'text', text: 'Need input.\n<question>Which file?</question>' } })
		event({ type: 'turn-end', sessionId: '07-bah', status: 'completed' })
		expect(await run.done).toBe(3)
		expect(out.join('')).toBe('Need input.\nWhich file?\n')
	})
})

test('print queues a user prompt and ignores the preceding turn', async () => {
	await harness({ prompt: 'answer', cwd: '/tmp', session: '1', delivery: 'queue' }, async ({ run, sent, event, out }) => {
		event(tabs)
		run.begin()
		expect(sent[0]).toMatchObject({ type: 'open', sessionId: '07-bah' })
		event({ type: 'snapshot', sessionId: '07-bah', snapshot: {} as any })
		let prompt = sent[1]
		expect(prompt).toMatchObject({ type: 'submit', text: 'answer', delivery: 'queue', interactive: false })
		expect(prompt.from).toBeUndefined()
		event({ type: 'inbox', sessionId: '07-bah', inbox: [{ id: prompt.id, text: 'answer' }] })
		event({ type: 'stream', sessionId: '07-bah', event: { type: 'text', text: 'unrelated' } })
		event({ type: 'turn-end', sessionId: '07-bah', status: 'completed' })
		expect(out).toEqual([])
		// Batched delivery need not carry this prompt's command id.
		event({ type: 'inbox', sessionId: '07-bah', inbox: [] })
		event({ type: 'turn-start', sessionId: '07-bah', provider: 'test', inbox: [prompt.id, 'another-message'] })
		event({ type: 'stream', sessionId: '07-bah', event: { type: 'text', text: '<summary>Done</summary>' } })
		event({ type: 'turn-end', sessionId: '07-bah', status: 'completed' })
		expect(await run.done).toBe(0)
		expect(out).toEqual(['Done\n'])
	})
})

test('print waits for asynchronous tabs, defaults to soft-steer, and rejects unknown targets', async () => {
	await harness({ prompt: 'answer', cwd: '/tmp', session: '07-bah' }, async ({ run, sent, event }) => {
		run.begin()
		expect(sent).toEqual([])
		event(tabs)
		event({ type: 'snapshot', sessionId: '07-bah', snapshot: {} as any })
		expect(sent[1].delivery).toBe('soft-steer')
		event({ type: 'rejected', id: sent[1].id, command: 'submit', reason: 'failed' })
		expect(await run.done).toBe(1)
	})
	await harness({ prompt: 'answer', cwd: '/tmp', session: '99' }, async ({ run, event, err }) => {
		run.begin(); event(tabs)
		expect(await run.done).toBe(2)
		expect(err).toEqual(['hal: no session 99\n'])
	})
})
