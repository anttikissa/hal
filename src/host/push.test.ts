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
	expect(statSync(`${paths.secretsDir()}/push-vapid.ason`).mode & 0o777).toBe(0o600)
	expect(statSync(`${paths.secretsDir()}/push-subscriptions.ason`).mode & 0o777).toBe(0o600)
	push.reset()
	expect(await push.keys()).toEqual(first)
	expect(push.store().subscriptions).toEqual([{ ...subscription, added: expect.any(String) }])
})

test('a user can test and remove a named device, and removal survives a restart', async () => {
	push.subscribe({ ...subscription, device: 'iPhone · Home Screen app' })
	expect(push.devices()).toEqual([{ endpoint: subscription.endpoint, device: 'iPhone · Home Screen app', added: expect.any(String) }])
	let original = push.request
	let sent = 0
	push.request = async () => (sent++, new Response(null, { status: 201 }))
	try { expect(await push.test(subscription.endpoint)).toStartWith('Test sent') } finally { push.request = original }
	expect(sent).toBe(1)
	push.unsubscribe(subscription.endpoint)
	push.reset()
	expect(push.devices()).toEqual([])
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

test('an unseen completed turn is pushed encrypted to the subscription, unless push is off', async () => {
	let c = client()
	let id = created(c)
	push.subscribe(subscription)
	let sent: { url: string; body: any }[] = []
	let original = push.request
	push.request = async (url, init) => { sent.push({ url, body: init.body }); return new Response(null, { status: 201 }) }
	try {
		c.conn.send({ type: 'submit', sessionId: id, text: 'hello' })
		await until(() => calls.length)
		calls[0]!.push({ type: 'done', reason: 'end' })
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
