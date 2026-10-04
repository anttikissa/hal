// Persistent web push identity/subscriptions and delivery. Nothing starts at import.
import type { Command, Event } from '../common/protocol.ts'
import { settings } from '../common/settings.ts'
import { diag } from './diag.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { secrets } from './secrets.ts'
import { pushCrypto, type PushKeys, type VapidKeys } from './push-crypto.ts'

// device: the browser's own label ("iPhone · Home Screen"); added: ISO time.
type Subscription = PushKeys & { endpoint: string; device?: string; added?: string }
type Store = { subscriptions: Subscription[] }

function valid(s: unknown): s is Subscription {
	if (!s || typeof s !== 'object') return false
	let v = s as Record<string, unknown>
	if (typeof v.endpoint !== 'string' || v.endpoint.length > 2048 || typeof v.auth !== 'string' || typeof v.p256dh !== 'string') return false
	let url = URL.parse(v.endpoint)
	if (v.device !== undefined && (typeof v.device !== 'string' || v.device.length > 80)) return false
	if (v.added !== undefined && (typeof v.added !== 'string' || v.added.length > 40)) return false
	return !!url && url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
		v.auth.length === 22 && v.p256dh.length === 87 &&
		/^[A-Za-z0-9_-]+$/.test(v.auth) && /^[A-Za-z0-9_-]+$/.test(v.p256dh) &&
		Buffer.from(v.auth, 'base64url').length === 16 && Buffer.from(v.p256dh, 'base64url').length === 65
}

function store(): Store {
	if (push.state.store) return push.state.store
	let data = secrets.file<Store>(`${paths.secretsDir()}/push-subscriptions.ason`, { subscriptions: [] }, { watch: false })
	if (!Array.isArray(data.subscriptions) || !data.subscriptions.every(push.valid)) {
		liveFiles.close(data)
		throw new Error(`${paths.display(`${paths.secretsDir()}/push-subscriptions.ason`)}: invalid subscriptions`)
	}
	return (push.state.store = data)
}

async function keys(): Promise<VapidKeys> {
	if (!push.state.keys) {
		push.state.keys = (async () => {
			let data = secrets.file<Partial<VapidKeys>>(`${paths.secretsDir()}/push-vapid.ason`, {}, { watch: false })
			try {
				if (!data.privateKey && !data.publicKey) Object.assign(data, await pushCrypto.generate())
				if (!data.publicKey || !data.privateKey || Buffer.from(data.publicKey, 'base64url').length !== 65) throw new Error(`${paths.display(`${paths.secretsDir()}/push-vapid.ason`)}: invalid key pair`)
				liveFiles.save(data)
				return { publicKey: data.publicKey, privateKey: data.privateKey }
			} finally { liveFiles.close(data) }
		})().catch((e) => { push.state.keys = null; throw e })
	}
	return push.state.keys
}

function subscribe(value: unknown): void {
	if (!push.valid(value)) throw new Error('invalid push subscription')
	let data = push.store()
	let added = data.subscriptions.find((s) => s.endpoint === value.endpoint)?.added ?? new Date().toISOString()
	data.subscriptions = [...data.subscriptions.filter((s) => s.endpoint !== value.endpoint), { ...value, added }]
	liveFiles.save(data)
}

function unsubscribe(endpoint: string): void {
	let data = push.store()
	data.subscriptions = data.subscriptions.filter((s) => s.endpoint !== endpoint)
	liveFiles.save(data)
}

function devices(): { endpoint: string; device?: string; added?: string }[] {
	return push.store().subscriptions.map(({ endpoint, device, added }) => ({ endpoint, device, added }))
}

// A test push straight to one device, even while it is watching.
async function test(endpoint: string): Promise<string> {
	if (!settings.push()) return 'Push is off in config.ason (push: false).'
	let s = push.store().subscriptions.find((entry) => entry.endpoint === endpoint)
	if (!s) return 'This device is not registered; turn notifications on first.'
	try {
		let error = await push.deliver(s, JSON.stringify({ id: '', title: 'Test notification', body: 'Push works on this device.' }))
		return error ?? 'Test sent. It should appear in a few seconds.'
	} catch (e: any) { return `Test failed: ${e?.message ?? e}` }
}

// Reuse per-origin tokens for up to 11 hours; Apple asks not to refresh
// more frequently than hourly and RFC 8292 caps expiry at 24 hours.
async function authorization(endpoint: string): Promise<string> {
	let origin = new URL(endpoint).origin
	let cached = push.state.tokens.get(origin)
	if (cached && cached.until > Date.now()) return cached.header
	let header = await pushCrypto.vapid(endpoint, await push.keys(), settings.webUrl().startsWith('https:') ? settings.webUrl() : 'mailto:hal@localhost')
	push.state.tokens.set(origin, { header, until: Date.now() + 11 * 3600_000 })
	return header
}

// Returns why delivery failed, if it did.
async function deliver(s: Subscription, message: string): Promise<string | undefined> {
	let body = await pushCrypto.encrypt(message, s)
	let res = await push.request(s.endpoint, {
		method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body,
		headers: { TTL: '14400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', Authorization: await push.authorization(s.endpoint) },
	})
	if (res.status === 404 || res.status === 410) {
		let data = push.store()
		data.subscriptions = data.subscriptions.filter((entry) => entry.endpoint !== s.endpoint)
		liveFiles.save(data)
		return `The push service no longer knows this device (${res.status}); it was removed.`
	}
	if (res.ok) return undefined
	diag.log(`push: service returned ${res.status}`)
	return `The push service refused it (${res.status}).`
}

async function notify(id: string, name: string, line: string): Promise<void> {
	if (!settings.push()) return
	let message = JSON.stringify({ id, title: name.slice(0, 80), body: line.slice(0, 120) })
	let all = push.store().subscriptions.slice(), sent = 0
	for (let s of all) {
		try { if (!(await push.deliver(s, message))) sent++ } catch (e: any) { diag.log(`push: ${e?.message ?? e}`) }
	}
	diag.log(`push: ${id} delivered to ${sent} of ${all.length} devices`)
}

// A client's push command, answered with the device list.
async function command(c: Extract<Command, { type: 'push-subscribe' | 'push' }>): Promise<Event> {
	let result: string | undefined
	if (c.type === 'push-subscribe') push.subscribe({ endpoint: c.subscription.endpoint, ...c.subscription.keys, ...(c.device ? { device: c.device } : {}) })
	else if (c.action === 'remove' && c.endpoint) push.unsubscribe(c.endpoint)
	else if (c.action === 'test' && c.endpoint) result = await push.test(c.endpoint)
	return { type: 'push-devices', devices: push.devices(), ...(result ? { result } : {}) }
}

function reset(): void {
	if (push.state.store) liveFiles.close(push.state.store)
	push.state.store = null
	push.state.keys = null
	push.state.tokens.clear()
}
export const push = {
	state: { store: null as Store | null, keys: null as Promise<VapidKeys> | null, tokens: new Map<string, { header: string; until: number }>() },
	request: (url: string, init: RequestInit) => fetch(url, init),
	valid, store, keys, subscribe, unsubscribe, devices, test, command, authorization, deliver, notify, reset,
}
