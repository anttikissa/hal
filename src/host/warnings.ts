// Warnings every client sees (tasks fwk, 2e): config.ason problems, plus
// standing warnings by source (resources, restart) that clients joining
// later get too, and one-time reports held until a client is there to
// see them. Hal's modules call these, never wrap each other.

import type { Event } from '../common/protocol.ts'
import type { Client } from './host.ts'
import { config } from './config.ts'
import { host } from './host.ts'

// Tells a client what is wrong with config.ason, then the standing warnings
// and the reports nobody has seen yet.
function send(client: Client): void {
	let text = config.warnings().join('; ')
	if (text) client.deliver({ type: 'warning', text })
	for (let text of warnings.state.standing.values()) client.deliver({ type: 'warning', text })
	for (let event of warnings.state.held.splice(0)) client.deliver(event)
}

// Delivers a one-time report to every client; with none connected (such
// as during startup), to the next one that joins.
function tell(event: Event): void {
	if (!host.state.clients.size) return void warnings.state.held.push(event)
	for (let client of host.state.clients) client.deliver(event)
}

// After config.ason changed: warns every client, refreshes /config modals.
function all(): void {
	let refresh = { ...config.event(), refresh: true as const }
	for (let client of host.state.clients) {
		warnings.send(client)
		client.deliver(refresh)
	}
}

// Sets a warning every client sees now and on joining; no text clears it.
function set(key: string, text?: string): void {
	if (!text) return void warnings.state.standing.delete(key)
	warnings.state.standing.set(key, text)
	for (let client of host.state.clients) client.deliver({ type: 'warning', text })
}

export const warnings = {
	state: { standing: new Map<string, string>(), held: [] as Event[] },
	send,
	tell,
	all,
	set,
}
