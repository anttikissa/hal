// Shared setup for the web controller tests (app*.test.ts): a fake
// connection, draft store and router whose effects land in `fx`, and
// helpers that press keys and build host events.

import { afterEach, beforeEach } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts, type Local } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { app } from './app.ts'
import { keys, type Target } from './keys.ts'
import { router } from './router.ts'
import { tabs } from './tabs.ts'

export const meta = { id: '1-abc', cwd: '/w', model: 'fake/m', createdAt: '2026-09-26T00:00:00Z' }
export const sessionId = meta.id
export const ts = '2026-09-26T00:00:01Z'

// What the app did: commands sent, drafts stored, redraws, the page
// address and its history entries, and the tab stored as shown last.
export const fx = {
	sent: [] as any[],
	stored: new Map<string, Local>(),
	redraws: 0,
	address: 'http://h/',
	history: [] as string[],
	lastTab: undefined as string | undefined,
}

const orig = {
	send: connection.send,
	connected: connection.connected,
	store: drafts.store,
	href: router.href,
	write: router.write,
	tabStore: { ...router.store },
	mac: tabs.mac,
}

export function useApp(): void {
	beforeEach(() => {
		fx.sent = []
		fx.stored = new Map()
		fx.redraws = 0
		app.reset()
		drafts.reset()
		connection.send = (c: any) => void fx.sent.push(c)
		connection.connected = () => true
		drafts.store = { load: (id) => fx.stored.get(id), save: (id, l) => void fx.stored.set(id, structuredClone(l)) }
		app.changed = () => void fx.redraws++
		fx.address = 'http://h/'
		fx.history = [fx.address]
		fx.lastTab = undefined
		router.href = () => fx.address
		router.write = (url, replace) => {
			fx.address = new URL(url, fx.address).href
			if (replace) fx.history[fx.history.length - 1] = fx.address
			else fx.history.push(fx.address)
		}
		router.store.load = () => fx.lastTab
		router.store.save = (id) => void (fx.lastTab = id)
		tabs.mac = () => true
	})

	afterEach(() => {
		connection.send = orig.send
		connection.connected = orig.connected
		drafts.store = orig.store
		Object.assign(router, { href: orig.href, write: orig.write })
		Object.assign(router.store, orig.tabStore)
		tabs.mac = orig.mac
		drafts.reset()
		app.reset()
	})
}

export const press = (
	key: string,
	target: Target,
	mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {},
) => keys.key({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods }, target)
export const message = (text: string, cursor = text.length): Target => ({ kind: 'message', text, cursor })
export const snapshot = (state: object, history: object[] = [], draft?: object): Event =>
	({ type: 'snapshot', sessionId, snapshot: { meta, history, state, ...(draft ? { draft } : {}) } }) as Event

export const tab = (id: string, extra: object = {}) => ({
	id,
	name: `name ${id}`,
	cwd: `/cwd/${id}`,
	model: 'fake/m',
	state: { type: 'idle' },
	...extra,
})
export const tabsEvent = (...tabs: object[]) => ({ type: 'tabs', tabs }) as Event
export const snapOf = (id: string, draft?: string): Event =>
	({
		type: 'snapshot',
		sessionId: id,
		snapshot: {
			meta: { ...meta, id },
			history: [],
			state: { type: 'idle' },
			...(draft ? { draft: { text: draft, rev: 1 } } : {}),
		},
	}) as Event
export const alt = (digit: number) =>
	press(String(digit), message(app.state.text), { altKey: true, code: `Digit${digit}` } as any)
