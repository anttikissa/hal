// Send keys (task 8kx): which delivery (task csn) each Enter chord gives
// a prompt. Plain values, so a plugin (plugins/keys.ts) rebinds one
// chord per line with plugin.set(sendKeys, 'enter', 'interrupt'); null
// leaves a chord unbound. Shift-Enter is always a newline. A terminal
// reads its own process's values; the web page gets the host's in the
// page (host/web.ts) and sees a change on its next load.

import type { Delivery } from './protocol.ts'

export type Chord = 'enter' | 'ctrl-enter' | 'alt-enter' | 'cmd-enter'
type Mods = { ctrl?: boolean; alt?: boolean; cmd?: boolean }

const chords: Chord[] = ['enter', 'ctrl-enter', 'alt-enter', 'cmd-enter']

export const sendKeys = {
	enter: 'interject' as Delivery | null,
	'ctrl-enter': 'interrupt' as Delivery | null,
	'alt-enter': 'queue' as Delivery | null,
	'cmd-enter': 'interject' as Delivery | null,

	// The chord an Enter with these modifiers is (one modifier at most).
	chord(m: Mods): Chord | undefined {
		let on = [m.ctrl && 'ctrl-enter', m.alt && 'alt-enter', m.cmd && 'cmd-enter'].filter(Boolean) as Chord[]
		return on.length > 1 ? undefined : (on[0] ?? 'enter')
	},
	// What Enter with these modifiers sends; undefined when unbound.
	delivery(m: Mods): Delivery | undefined {
		let c = sendKeys.chord(m)
		return (c && sendKeys[c]) ?? undefined
	},
	// The chord that sends `d`, for help text: plain Enter first.
	key(d: Delivery): Chord | undefined {
		return chords.find((c) => sendKeys[c] === d)
	},
	// The chord's name in prose, such as 'Alt-Enter'; 'no key' when unbound.
	name(d: Delivery): string {
		return sendKeys.key(d)?.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase()) ?? 'no key'
	},
	// Help-row hints: busy names steer, interrupt and queue; idle, send and queue.
	hints(busy: boolean): [Chord, string][] {
		let send = chords.find((c) => sendKeys[c] && sendKeys[c] !== 'queue')
		let pairs: [Chord | undefined, string][] = busy
			? [[sendKeys.key('interject'), 'steer'], [sendKeys.key('interrupt'), 'interrupt'], [sendKeys.key('queue'), 'queue']]
			: [[send, 'send'], [sendKeys.key('queue'), 'queue']]
		return pairs.filter((p): p is [Chord, string] => p[0] !== undefined)
	},
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
			if (v === null || v === 'queue' || v === 'interject' || v === 'interrupt') sendKeys[c] = v
		}
	},
}
