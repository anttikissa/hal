// Link codes (task e3): a terminal client that asks ({type: 'auth',
// link: true}) is given the host's public web address and a one-time
// code (web-auth.ts) for the hidden OSC 8 targets of the links it
// prints. Codes are not minted per frame: each client holds one, and
// gets a new one when it is redeemed and before it is renewMs() old,
// so a link painted with it works for at least codeMs() - renewMs().
// Codes are delivered only as events, never stored or logged.

import type { Event } from '../common/protocol.ts'
import { settings } from '../common/settings.ts'
import { webAuth } from './web-auth.ts'

type Holder = { deliver: (event: Event) => void; code: string; timer: ReturnType<typeof setTimeout> }

// Gives `key`'s client a fresh code and the address, replacing any it had.
function follow(key: object, deliver: (event: Event) => void): void {
	webLinks.drop(key)
	let code = webAuth.issue()
	let timer = setTimeout(() => webLinks.follow(key, deliver), webLinks.renewMs())
	timer.unref?.()
	webLinks.state.holders.set(key, { deliver, code, timer })
	deliver({ type: 'auth', code, link: settings.webUrl() })
}

// The client went away.
function drop(key: object): void {
	let held = webLinks.state.holders.get(key)
	if (held) clearTimeout(held.timer)
	webLinks.state.holders.delete(key)
}

// A code was just redeemed: whoever held it gets a new one.
function used(code: string): void {
	for (let [key, held] of webLinks.state.holders) if (held.code === code) webLinks.follow(key, held.deliver)
}

// The web address changed (the server bound after clients asked, maybe
// on another port than the preferred one): everyone gets it again.
// A copy: follow re-inserts each holder, which a live Map iteration
// would visit again forever.
function moved(): void {
	for (let [key, held] of Array.from(webLinks.state.holders)) webLinks.follow(key, held.deliver)
}

function reset(): void {
	for (let key of webLinks.state.holders.keys()) webLinks.drop(key)
}

export const webLinks = {
	state: { holders: new Map<object, Holder>() },
	renewMs: (): number => webAuth.codeMs / 2 - 30_000,
	follow,
	drop,
	used,
	moved,
	reset,
}
