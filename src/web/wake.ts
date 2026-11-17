/// <reference lib="dom" />
// Replaces stale browser connections on return, including sleep that emits
// no lifecycle event. The local clock check never polls the server.
import { connection } from '../common/connection.ts'
import { app } from './app.ts'

function refresh(): void {
	let now = Date.now()
	if (!wake.visible() || now - wake.state.refreshed < wake.checkMs) return
	wake.state.refreshed = now
	wake.state.checked = now
	wake.state.hidden = false
	connection.reconnect(app.state.shown)
}

function visibility(): void {
	wake.state.hidden = !wake.visible()
	if (!wake.state.hidden) wake.refresh()
	app.changed()
}

function check(): void {
	let now = Date.now()
	if (now - wake.state.checked > wake.gapMs) wake.refresh()
	wake.state.checked = now
}

function start(): void {
	wake.stop()
	wake.state.hidden = !wake.visible()
	wake.state.checked = Date.now()
	wake.state.refreshed = wake.state.checked
	wake.state.timer = setInterval(() => wake.check(), wake.checkMs)
	addEventListener('focus', wake.refresh)
	addEventListener('online', wake.refresh)
	addEventListener('pageshow', wake.restored)
	document.addEventListener('visibilitychange', wake.visibility)
}

function stop(): void {
	clearInterval(wake.state.timer)
	wake.state.timer = undefined
	if (typeof document === 'undefined') return
	removeEventListener('focus', wake.refresh)
	removeEventListener('online', wake.refresh)
	removeEventListener('pageshow', wake.restored)
	document.removeEventListener('visibilitychange', wake.visibility)
}

export const wake = {
	checkMs: 1000,
	gapMs: 5000,
	state: {
		hidden: false,
		checked: 0,
		refreshed: -Infinity,
		timer: undefined as ReturnType<typeof setInterval> | undefined,
	},
	visible: (): boolean => document.visibilityState === 'visible',
	refresh,
	visibility,
	check,
	start,
	stop,
	restored: (event: PageTransitionEvent): void => {
		if (event.persisted) wake.refresh()
	},
}
