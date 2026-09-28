/// <reference lib="dom" />
// Web push stays on a real tap: never request permission on page load.
import { connection } from '../common/connection.ts'
import type { Tab } from '../common/protocol.ts'

function supported(): boolean {
	return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && location.protocol === 'https:'
}

function key(): Uint8Array<ArrayBuffer> | undefined {
	let text = document.getElementById('push-key')?.textContent
	let encoded: unknown
	try { encoded = JSON.parse(text ?? 'null') } catch { return undefined }
	if (typeof encoded !== 'string') return undefined
	let raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
	return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

const state: { registration?: ServiceWorkerRegistration; subscription?: PushSubscription | null } = {}
function available(): boolean {
	return push.supported() && !!push.state.registration && !!push.key() && Notification.permission === 'default'
}

function send(subscription: PushSubscription): void {
	let json = subscription.toJSON()
	if (json.endpoint && json.keys?.p256dh && json.keys.auth) connection.send({ type: 'push-subscribe', subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } } })
}

async function enable(): Promise<void> {
	let publicKey = push.key()
	let ready = push.state.registration
	if (!push.supported() || !publicKey || !ready) throw new Error('push needs an HTTPS home-screen app')
	// subscribe() is invoked synchronously by the tap, before any await:
	// iOS requires the subscription prompt to be user-initiated.
	let subscription = push.state.subscription ?? await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
	push.state.subscription = subscription
	push.send(subscription)
}

async function start(changed: () => void = () => {}): Promise<void> {
	if (!push.supported()) return
	let ready = await navigator.serviceWorker.register('/sw.js')
	let subscription = await ready.pushManager.getSubscription()
	push.state.registration = ready
	push.state.subscription = subscription
	if (subscription) push.send(subscription) // reconnect a persisted subscription
	changed()
}

function visibility(id?: string): void {
	if (typeof document === 'undefined' || !connection.connected() || !id) return
	connection.send({ type: 'visibility', sessionId: id, visible: document.visibilityState === 'visible' && document.hasFocus() })
}

function badge(tabs: Tab[]): void {
	if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return
	let count = tabs.filter((tab) => tab.attention).length
	void (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {})
}

export const push = { state, supported, key, available, send, enable, start, visibility, badge }
