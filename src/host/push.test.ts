import { expect, test } from 'bun:test'
import { statSync } from 'fs'
import { settings } from '../common/settings.ts'
import { client, created, until, useHost, calls } from './host-fixture.test.ts'
import { paths } from './paths.ts'
import { push } from './push.ts'

useHost()
const subscription = { endpoint: 'https://push.example.test/s/abc', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' }

test('VAPID key survives restart and state files have owner-only permissions', async () => {
	let first = await push.keys()
	push.subscribe(subscription)
	expect(statSync(`${paths.stateDir()}/push-vapid.ason`).mode & 0o777).toBe(0o600)
	expect(statSync(`${paths.stateDir()}/push-subscriptions.ason`).mode & 0o777).toBe(0o600)
	push.reset()
	expect(await push.keys()).toEqual(first)
	expect(push.store().subscriptions).toEqual([subscription])
})

test('expired endpoint is removed after 410, surviving a restart', async () => {
	push.subscribe(subscription)
	let original = push.request
	push.request = async () => new Response(null, { status: 410 })
	try {
		await push.notify('session-1', 'my session', 'done')
		expect(push.store().subscriptions).toEqual([])
		push.reset()
		expect(push.store().subscriptions).toEqual([])
	} finally { push.request = original }
})

test('a completed turn pushes when unseen but not while another client shows it', async () => {
	let c = client()
	let id = created(c)
	push.subscribe(subscription)
	let sent: { url: string; body: any }[] = []
	let original = push.request
	push.request = async (url, init) => { sent.push({ url, body: init.body }); return new Response(null, { status: 201 }) }
	try {
		c.conn.send({ type: 'visibility', sessionId: id, visible: true })
		c.conn.send({ type: 'submit', sessionId: id, text: 'hello' })
		await until(() => calls.length)
		calls[0]!.push({ type: 'done', reason: 'end' })
		await until(() => c.of('turn-end').length)
		await Bun.sleep(10)
		expect(sent).toHaveLength(0)
		c.conn.send({ type: 'visibility', sessionId: id, visible: false })
		c.conn.send({ type: 'submit', sessionId: id, text: 'again' })
		await until(() => calls.length === 2)
		calls[1]!.push({ type: 'done', reason: 'end' })
		await until(() => sent.length)
		expect(sent[0]!.url).toBe(subscription.endpoint)
		expect(sent[0]!.body).toBeInstanceOf(Uint8Array)
		settings.state.raw = { push: false }
		await push.notify(id, 'my session', 'done')
		expect(sent).toHaveLength(1)
	} finally { settings.state.raw = {}; push.request = original }
})

test('subscriptions reject malformed endpoints before fetching', () => {
	for (let endpoint of ['http://localhost:8000/private', 'file:///etc/passwd', 'https://user:password@push.example.test/']) {
		expect(() => push.subscribe({ ...subscription, endpoint })).toThrow('invalid push subscription')
	}
})
