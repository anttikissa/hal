// The hal serve log (task kp0): one human-readable line per event on
// stdout, for journald or a screen. Only `hal serve` turns it on; the
// terminal UI owns stdout elsewhere. Silent while nothing happens, except
// an hourly stats line. Errors are written whole; other text is cut to
// one line so the log stays readable.

import { ason } from '../common/ason.ts'
import type { Event } from '../common/protocol.ts'
import { perf } from '../common/perf.ts'
import type { ClientRecord } from './clients.ts'

const width = 100
const hourMs = 60 * 60 * 1000

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

// "2026-10-14 12:31:05.123", local time.
function stamp(d = new Date()): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function log(text: string, data?: object): void {
	if (!serverLog.state.on) return
	serverLog.write(`${stamp()} ${text}${data ? ` ${ason.stringify(data, 'short')}` : ''}\n`)
}

// "(57 ms)": time since this process started.
function ms(): string {
	return `(${Math.round(perf.now() - perf.state.epoch)} ms)`
}

// `text` on one line, short enough that a log line with `prefix` before
// it fits `width` columns.
function cut(text: string, prefix = ''): string {
	let one = text.replace(/\s+/g, ' ').trim()
	let room = Math.max(20, width - stamp().length - 1 - prefix.length)
	return one.length > room ? `${one.slice(0, room - 1)}…` : one
}

function say(prefix: string, text: string): void {
	serverLog.log(`${prefix}${serverLog.cut(text, prefix)}`)
}

// Assistant text streams in pieces: kept per session until the block ends
// (any other event of that session), then written as one line.
function flush(id: string): void {
	let text = serverLog.state.text.get(id)
	if (text === undefined) return
	serverLog.state.text.delete(id)
	if (text.trim()) say(`${id} hal: `, text)
}

// A session event, as host.broadcast sends it to clients.
function event(id: string, e: Event): void {
	let st = serverLog.state
	if (!st.on) return
	if (e.type === 'stream' && e.event.type === 'text') {
		let text = (st.text.get(id) ?? '') + e.event.text
		// Only the first line is written; keep a little more to know it is cut.
		st.text.set(id, text.length > 2 * width ? text.slice(0, 2 * width) : text)
		return
	}
	if (e.type === 'stream') return
	flush(id)
	if (e.type === 'turn-start') {
		st.started.set(id, Date.now())
		if (e.prompt) say(`${id} ${e.sender?.from ? `from ${e.sender.from}` : 'you'}: `, e.prompt)
	} else if (e.type === 'prompt') {
		e.texts.forEach((text, i) => say(`${id} ${e.senders?.[i]?.from ? `from ${e.senders[i]!.from}` : 'you'}: `, text))
	} else if (e.type === 'command' && e.origin !== 'model') say(`${id} command: `, e.text)
	else if (e.type === 'output' && e.error) serverLog.log(`${id} command failed: ${e.text}`)
	else if (e.type === 'question') say(`${id} asks: `, e.form.text)
	else if (e.type === 'turn-end') {
		let start = st.started.get(id)
		st.started.delete(id)
		let took = start === undefined ? '' : ` ${Math.round((Date.now() - start) / 1000)} s`
		serverLog.log(`${id} turn ${e.status}${took}`)
		if (e.error) serverLog.log(`${id} error: ${e.error}`)
	}
}

// A number per connection, in the order they joined.
function number(rec: ClientRecord): number {
	let st = serverLog.state
	let n = st.numbers.get(rec)
	if (n === undefined) st.numbers.set(rec, (n = ++st.next))
	return n
}

function client(rec: ClientRecord): string {
	return `#${serverLog.number(rec)} ${rec.kind}`
}

function joined(rec: ClientRecord): void {
	serverLog.log(`client connected ${client(rec)}`, rec.address || rec.userAgent ? { ...(rec.address && { ip: rec.address }), ...(rec.userAgent && { agent: rec.userAgent }) } : undefined)
}

function hello(rec: ClientRecord): void {
	serverLog.log(`client ${client(rec)} is pid ${rec.pid}`, rec.version ? { version: rec.version } : undefined)
}

function left(rec: ClientRecord): void {
	let min = Math.round((Date.now() - rec.connectedAt) / 60_000)
	serverLog.log(`client left ${client(rec)} (${min < 1 ? 'under a minute' : `${min} min`})`)
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

// Starts the log, and the hourly stats line from `stats`.
function start(stats: () => object): void {
	let st = serverLog.state
	if (st.on) return
	st.on = true
	st.timer = setInterval(() => serverLog.log('stats', stats()), serverLog.hourMs)
	st.timer.unref?.()
}

export const serverLog = {
	state: { on: false, timer: undefined as ReturnType<typeof setInterval> | undefined, text: new Map<string, string>(), started: new Map<string, number>(), numbers: new WeakMap<ClientRecord, number>(), next: 0 },
	hourMs,
	write: (line: string): void => void process.stdout.write(line),
	stamp, log, ms, cut, event, number, client, joined, hello, left, gb, mb, start,
}
