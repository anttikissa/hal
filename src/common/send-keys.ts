// Send keys (task 8kx): which delivery (task csn) each Enter chord gives
// a prompt. Plain values, so a plugin (plugins/keys.ts) rebinds one
// chord per line with plugin.set(sendKeys, 'enter', 'soft-steer'); null
// leaves a chord unbound. Shift-Enter is always a newline. A terminal
// reads its own process's values; the web page gets the host's in the
// page (host/web.ts) and sees a change on its next load.

import type { Delivery } from './protocol.ts'
import type { SessionState } from './states.ts'

export type Chord = 'enter' | 'ctrl-enter' | 'alt-enter' | 'cmd-enter'
type Mods = { ctrl?: boolean; alt?: boolean; cmd?: boolean }

const chords: Chord[] = ['enter', 'ctrl-enter', 'alt-enter', 'cmd-enter']

// A slash command being typed (bare / too), not an absolute file path.
const commandDraft = (text: string) => /^\/(?:[a-z][a-z0-9-]*(?:\s|$)|$)/.test(text.trim())

export const sendKeys = {
	enter: 'steer' as Delivery | null,
	'ctrl-enter': 'soft-steer' as Delivery | null,
	'alt-enter': 'queue' as Delivery | null,
	'cmd-enter': 'steer' as Delivery | null,

	// The chord an Enter with these modifiers is (one modifier at most).
	chord(m: Mods): Chord | undefined {
		let on = [m.ctrl && 'ctrl-enter', m.alt && 'alt-enter', m.cmd && 'cmd-enter'].filter(Boolean) as Chord[]
		return on.length > 1 ? undefined : (on[0] ?? 'enter')
	},
	// What Enter with these modifiers sends; undefined when unbound.
	delivery(m: Mods): Delivery | undefined {
		let c = sendKeys.chord(m)
		return (c && sendKeys.parse(sendKeys[c])) || undefined
	},
	// A delivery from outside (a command, a stored draft, a plugin);
	// undefined when not one.
	parse(v: unknown): Delivery | undefined {
		// LEGACY-DELIVERY (task 760): old clients and drafts send interrupt
		// and interject. Delete by 2026-10-10 (prompt.test.ts fails then).
		if (v === 'interrupt') return 'steer'
		if (v === 'interject') return 'soft-steer'
		return v === 'steer' || v === 'soft-steer' || v === 'queue' ? v : undefined
	},
	// The chord that sends `d`, for help text: plain Enter first.
	key(d: Delivery): Chord | undefined {
		return chords.find((c) => sendKeys.parse(sendKeys[c]) === d)
	},
	// The chord's name in prose, such as 'Alt-Enter'; 'no key' when unbound.
	name(d: Delivery): string {
		return sendKeys.key(d)?.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase()) ?? 'no key'
	},
	// The help rows' hints for a session's state and prompt text, shared
	// by the terminal and the web (task h67). Commands never queue (7t).
	hints(state: SessionState | undefined, text: string): [string, string][] {
		let working = state?.type === 'running' || state?.type === 'retrying' || state?.type === 'blocked'
		let esc: [string, string][] = working ? [['esc', 'pause']] : []
		if (!text.trim()) {
			if (state?.type === 'retrying') return [['enter', 'retry now'], ...esc]
			if (state?.type === 'paused') return [['enter', 'continue']]
			if (state?.type === 'error') return [['enter', 'retry']]
			return esc
		}
		if (commandDraft(text)) return [['enter', 'run'], ['shift-enter', 'newline'], ...esc]
		let send = chords.find((c) => sendKeys[c] && sendKeys[c] !== 'queue')
		// Busy: each bound chord named by its delivery, Enter's first.
		let pairs = working ? (['steer', 'soft-steer'] as const).map((d) => [sendKeys.key(d), d]).sort((a, b) => chords.indexOf(a[0] as Chord) - chords.indexOf(b[0] as Chord)) : [[send, 'send']]
		pairs.push(['shift-enter', 'newline'], [sendKeys.key('queue'), 'queue'], ...esc)
		return pairs.filter((p): p is [string, string] => !!p[0])
	},
	commandDraft,
	forPage(): string {
		return JSON.stringify(Object.fromEntries(chords.map((c) => [c, sendKeys[c]])))
	},
	// The page's side of forPage; anything unknown keeps the default.
	load(json: string | null | undefined): void {
		let raw: unknown
		try {
			raw = JSON.parse(json || '{}')
		} catch {
			return
		}
		if (!raw || typeof raw !== 'object') return
		for (let c of chords) {
			let v = (raw as Record<string, unknown>)[c]
			if (v === null || sendKeys.parse(v)) sendKeys[c] = v === null ? null : sendKeys.parse(v)!
		}
	},
}
