// The browser's connection to the host: one WebSocket at /ws, each
// message one ASON command or event. When it drops, dial again with
// backoff; on every (re)connect, send the opening command again, so the
// session arrives as a fresh snapshot, like a restarted terminal.

import { ason } from '../common/ason.ts'
import type { Event } from '../common/protocol.ts'

// The part of a WebSocket this uses, so tests can pass a fake.
export type Socket = {
	send(data: string): void
	close(): void
	onopen: ((ev?: any) => void) | null
	onmessage: ((m: any) => void) | null
	onclose: ((ev?: any) => void) | null
}

export type LinkOptions = {
	dial: () => Socket
	// The command that opens (or creates) the session, asked each connect.
	opening: () => Promise<unknown>
	onEvent: (event: Event) => void
	onConnected?: (connected: boolean) => void
	// Timers, overridable in tests.
	setTimeout?: (fn: () => void, ms: number) => unknown
}

type LinkState = { opts: LinkOptions | null; socket: Socket | null; connected: boolean; failures: number }

function createState(): LinkState {
	return { opts: null, socket: null, connected: false, failures: 0 }
}

// Milliseconds to wait before redial number `failures` (0-based).
function delay(failures: number): number {
	return Math.min(link.maxDelayMs(), 250 * 2 ** failures)
}

function connect(): void {
	let opts = link.state.opts
	if (!opts) return
	let socket = opts.dial()
	link.state.socket = socket
	socket.onopen = async () => {
		link.state.failures = 0
		link.state.connected = true
		opts.onConnected?.(true)
		let command = await opts.opening()
		if (link.state.socket === socket) link.send(command)
	}
	socket.onmessage = (m) => {
		let event: Event
		try {
			event = ason.parse(String(m.data)) as Event
		} catch {
			return
		}
		opts.onEvent(event)
	}
	socket.onclose = () => {
		if (link.state.socket !== socket) return
		link.state.socket = null
		if (link.state.connected) opts.onConnected?.(false)
		link.state.connected = false
		let wait = link.delay(link.state.failures++)
		;(opts.setTimeout ?? globalThis.setTimeout)(() => link.state.socket === null && link.state.opts === opts && link.connect(), wait)
	}
}

function start(opts: LinkOptions): void {
	link.state = { ...createState(), opts }
	link.connect()
}

// Sends a command if connected; false if not (nothing is queued: the
// page keeps the typed text).
function send(command: unknown): boolean {
	if (!link.state.connected || !link.state.socket) return false
	link.state.socket.send(ason.stringify(command, 'short'))
	return true
}

function stop(): void {
	let socket = link.state.socket
	link.state = createState()
	socket?.close()
}

export const link = { state: createState(), maxDelayMs: () => 10_000, delay, connect, start, send, stop }
