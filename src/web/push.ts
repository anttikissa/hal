/// <reference lib="dom" />
// Web push stays on a real tap: never request permission on page load.
import { createSignal } from 'solid-js'
import { connection } from '../common/connection.ts'
import type { Event, Tab } from '../common/protocol.ts'

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

// A readable name for this device, for the device list.
function device(): string {
	let ua = navigator.userAgent
	let os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device'
	let app = matchMedia('(display-mode: standalone)').matches ? 'Home Screen app' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser'
	return `${os} · ${app}`
}

function send(subscription: PushSubscription): void {
	let json = subscription.toJSON()
	if (json.endpoint && json.keys?.p256dh && json.keys.auth) connection.send({ type: 'push-subscribe', subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, device: push.device() })
}

type Devices = Extract<Event, { type: 'push-devices' }>
const [devices, setDevices] = createSignal<Devices>({ type: 'push-devices', devices: [] })
const [mine, setMine] = createSignal<string | undefined>()

// This device: unsupported (not an HTTPS Home Screen app), blocked in Settings, on or off.
function status(): 'unsupported' | 'blocked' | 'on' | 'off' {
	if (!push.supported() || !push.key() || !push.state.registration) return 'unsupported'
	if (Notification.permission === 'denied') return 'blocked'
	return mine() ? 'on' : 'off'
}

async function disable(): Promise<void> {
	let subscription = push.state.subscription
	push.state.subscription = null
	setMine(undefined)
	if (!subscription) return
	connection.send({ type: 'push', action: 'remove', endpoint: subscription.endpoint })
	await subscription.unsubscribe()
}

function remove(endpoint: string): void {
	if (endpoint === mine()) return void push.disable()
	connection.send({ type: 'push', action: 'remove', endpoint })
}

function test(): void {
	let endpoint = mine()
	if (endpoint) connection.send({ type: 'push', action: 'test', endpoint })
}

async function enable(): Promise<void> {
	let publicKey = push.key()
	let ready = push.state.registration
	if (!push.supported() || !publicKey || !ready) throw new Error('push needs an HTTPS home-screen app')
	// subscribe() is invoked synchronously by the tap, before any await:
	// iOS requires the subscription prompt to be user-initiated.
	let subscription = push.state.subscription ?? await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
	push.state.subscription = subscription
	setMine(subscription.endpoint)
	push.send(subscription)
}

async function start(changed: () => void = () => {}): Promise<void> {
	if (!push.supported()) return
	let ready = await navigator.serviceWorker.register('/sw.js')
	let subscription = await ready.pushManager.getSubscription()
	push.state.registration = ready
	push.state.subscription = subscription
	setMine(subscription?.endpoint)
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

export const push = { state, supported, key, available, device, send, devices, setDevices, mine, status, enable, disable, remove, test, start, visibility, badge }
