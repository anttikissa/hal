// Shared fixtures for the terminal app tests: the app with a recording
// link and renderer (what the user types becomes commands, and what the
// host says becomes the view), keys, snapshots and tabs.

import { afterEach, beforeEach } from 'bun:test'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event, Tab } from '../common/protocol.ts'
import type { Snapshot } from '../common/snapshot.ts'
import type { SessionState } from '../common/states.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import type { KeyEvent } from './keys.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'
import { titles } from '../common/titles.ts'

// Commands as sent, ids left out; draft updates are in `drafted`,
// visibility reports in `watched`. Emptied before each test.
export const sent: any[] = []
export const drafted: any[] = []
export const watched: any[] = []
export let quits = 0
export const saved = { send: app.send, show: render.show, quit: terminal.quit, draftSend: drafts.send }
const wasConnected = connection.connected
export const record = (c: any) => {
	let { id: _id, ...rest } = c
	if (c.type === 'draft') drafted.push(rest)
	else if (c.type === 'visibility') watched.push(rest)
	else sent.push(rest)
}

// Installs the recording app around each test.
export function useApp(): void {
	let originalNames: Record<string, string>
	beforeEach(() => {
		originalNames = titles.names
		titles.names = { 'anthropic/claude-opus-5-5': 'Opus 5.5' }
		sent.length = 0
		drafted.length = 0
		watched.length = 0
		quits = 0
		app.reset()
		app.send = record
		connection.connected = () => true
		drafts.send = record
		render.show = () => {}
		terminal.quit = () => {
			quits++
		}
	})

	afterEach(() => {
		titles.names = originalNames
		Object.assign(app, { send: saved.send })
		connection.connected = wasConnected
		drafts.send = saved.draftSend
		render.show = saved.show
		terminal.quit = saved.quit
		app.reset()
	})
}

export const snapshot = (id = 's1', state: SessionState = { type: 'idle' }, draft?: Snapshot['draft']): Event => {
	let snap: Snapshot = { meta: { id, cwd: '/', model: 'anthropic/x', createdAt: '' }, history: [], state }
	if (draft) snap.draft = draft
	return { type: 'snapshot', sessionId: id, snapshot: snap }
}
export const key = (key: string, text?: string): KeyEvent => ({
	key,
	text,
	shift: false,
	alt: false,
	ctrl: false,
	cmd: false,
})
export const type = (s: string) => app.onKeys([...s].map((c) => key(c, c)))
export const enter = () => app.onKeys([key('enter')])
export const escape = () => app.onKeys([key('escape')])

// A session working on `prompt`, as the host would show it.
export function working(prompt = 'fix ti') {
	app.onEvent(snapshot('s1', { type: 'running', phase: 'streaming' }))
	app.onEvent({ type: 'turn-start', sessionId: 's1', prompt, provider: 'anthropic', n: 5 })
}
export const up = () => app.onKeys([key('up')])
export const down = () => app.onKeys([key('down')])
export const paused = () => app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'paused' } })

// ── Tabs ──

export const tabOf = (id: string, extra: Partial<Tab> = {}): Tab => ({
	id,
	name: id,
	cwd: `/${id}`,
	model: 'm',
	state: { type: 'idle' },
	...extra,
})
export const tabsEvent = (...list: (string | Tab)[]): Event => ({
	type: 'tabs',
	tabs: list.map((t) => (typeof t === 'string' ? tabOf(t) : t)),
})
export const ctrl = (k: string, shift = false): KeyEvent => ({ key: k, shift, alt: false, ctrl: true, cmd: false })
export const alt = (k: string): KeyEvent => ({ key: k, shift: false, alt: true, ctrl: false, cmd: false })
export const acked = (tab: string) => app.onEvent({ type: 'ack', id: 'x', tab })
// Starts on tab `a` of `ids`, with its snapshot in.
export const startOn = (ids: string[], at = 'a') => {
	app.onEvent(tabsEvent(...ids))
	acked(at)
	app.onEvent(snapshot(at))
	sent.length = 0
}
export const shown = () => appView.view().tabs?.focused

// A session that was sent `prompts`, idle again.
export function sentBefore(...prompts: string[]) {
	app.onEvent(snapshot())
	for (let prompt of prompts) app.onEvent({ type: 'turn-start', sessionId: 's1', prompt, provider: 'anthropic' })
	app.onEvent({ type: 'state', sessionId: 's1', state: { type: 'idle' } })
}
