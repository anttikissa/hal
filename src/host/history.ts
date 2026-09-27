// Durable conversation history: sessions/<id>/history.asonl, one record
// per line (src/common/replay.ts), appended as the conversation happens.
// Provider input for every turn is rebuilt from this file alone.
//
// Opening a session repairs its history: a partially written last record
// (the host died mid-write) is cut off. Any other malformed record is
// reported and the file is left untouched. A turn with no end record is
// unfinished, not broken: the host continues it (turns.recover).

import { appendFileSync, existsSync, openSync, readFileSync, readSync as readFd, closeSync, statSync, truncateSync } from 'fs'
import { ason } from '../common/ason.ts'
import { blocks, type DoneEvent, type ErrorEvent, type StreamEvent, type ToolResultBlock, type Turn, type Usage, type UserBlock } from '../common/blocks.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { blobs } from './blobs.ts'
import { diag } from './diag.ts'
import { paths } from './paths.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { sessions, type SessionMeta } from './sessions.ts'

type NewRecord = HistoryRecord extends infer R ? (R extends HistoryRecord ? Omit<R, 'ts'> : never) : never

const recordTypes = new Set(['user', 'assistant', 'turn_end', 'continue', 'inbox', 'question', 'answer', 'command', 'output', 'change'])

// One running turn: its current provider round (`turn`), how many of
// that round's blocks are on disk, and the usage of earlier rounds.
// `ended`: stop() has written its last record; nothing more is written.
type Running = { turn: Turn; written: number; prior: Usage; ended?: boolean }

function addUsage(a: Usage, b: Usage): Usage {
	let sum = { ...a }
	for (let [k, v] of Object.entries(b)) if (v !== undefined) sum[k as keyof Usage] = (sum[k as keyof Usage] ?? 0) + v
	return sum
}

function check(value: unknown): HistoryRecord {
	let r = value as HistoryRecord
	if (!r || typeof r !== 'object' || !recordTypes.has(r.type)) throw new Error(`unknown record ${ason.stringify(value, 'short').slice(0, 80)}`)
	return r
}

function file(id: string): string {
	return `${paths.sessionDir(id)}/history.asonl`
}

function append(id: string, record: NewRecord): void {
	appendFileSync(history.file(id), ason.stringifyLine({ ...record, ts: new Date().toISOString() }))
}

// `command`: the client's id for the submit, so a resend is recognised.
function submit(id: string, prompt: string | UserBlock[], command?: string): void {
	let content = typeof prompt === 'string' ? [{ type: 'text' as const, text: prompt }] : prompt
	history.append(id, command === undefined ? { type: 'user', blocks: content } : { type: 'user', blocks: content, command })
}

async function load(id: string): Promise<{ records: HistoryRecord[]; partial?: string }> {
	let path = history.file(id)
	if (!existsSync(path)) return { records: [] }
	let records: HistoryRecord[] = []
	let partial: string | undefined
	try {
		for await (let value of ason.parseStream(Bun.file(path).stream(), { onPartial: (s) => (partial = s) })) {
			records.push(history.check(value))
		}
	} catch (e: any) {
		throw new Error(`${path}: malformed history: ${e?.message ?? e}`)
	}
	return { records, partial }
}

// Every complete record. Read-only: a partial last record is skipped.
async function read(id: string): Promise<HistoryRecord[]> {
	return (await history.load(id)).records
}

// read() for callers that must not yield, such as a snapshot taken in
// the same step as its live events. Appends are synchronous, so within
// this process only a crash leaves a partial line; it is skipped.
function readSync(id: string): HistoryRecord[] {
	let path = history.file(id)
	if (!existsSync(path)) return []
	let lines = readFileSync(path, 'utf8').split('\n')
	let last = lines.pop()!
	let records: HistoryRecord[] = []
	try {
		for (let line of lines) if (line.trim()) records.push(history.check(ason.parse(line)))
		if (last.trim()) {
			try {
				records.push(history.check(ason.parse(last)))
			} catch {}
		}
	} catch (e: any) {
		throw new Error(`${path}: malformed history: ${e?.message ?? e}`)
	}
	return records
}

function lastByte(path: string): number | undefined {
	let size = statSync(path).size
	if (!size) return undefined
	let fd = openSync(path, 'r')
	try {
		let buf = Buffer.alloc(1)
		readFd(fd, buf, 0, 1, size - 1)
		return buf[0]
	} finally {
		closeSync(fd)
	}
}

// The last records, oldest first: every whole line in the file's last
// 64 KiB, or the whole history if the last line is longer (or cut off),
// so a new host can check every session cheaply.
function tail(id: string): HistoryRecord[] {
	let path = history.file(id)
	if (!existsSync(path)) return []
	let size = statSync(path).size
	let fd = openSync(path, 'r')
	let text: string
	try {
		let buf = Buffer.alloc(Math.min(size, 65536))
		readFd(fd, buf, 0, buf.length, size - buf.length)
		text = buf.toString('utf8')
	} finally {
		closeSync(fd)
	}
	let lines = text.split('\n').filter((l) => l.trim())
	if (size > 65536) lines.shift()
	let out: HistoryRecord[] = []
	try {
		for (let line of lines) out.push(history.check(ason.parse(line)))
	} catch {
		return history.readSync(id)
	}
	return out.length ? out : history.readSync(id)
}

// True if the last turn has no end record.
function unfinished(id: string): boolean {
	let last = replay.withoutCommands(history.tail(id)).at(-1)
	return last !== undefined && last.type !== 'turn_end'
}

// Opens the session and repairs its history so appends land cleanly.
async function open(id: string): Promise<SessionMeta> {
	let meta = sessions.open(id)
	let path = history.file(id)
	let loaded: Awaited<ReturnType<typeof load>>
	try {
		loaded = await history.load(id)
	} catch (e) {
		sessions.close(id)
		throw e
	}
	if (loaded.partial !== undefined) {
		let bytes = Buffer.byteLength(loaded.partial)
		// The fragment may end in a cut-off character the decoder dropped.
		let text = await Bun.file(path).bytes()
		truncateSync(path, text.lastIndexOf(10) + 1)
		diag.log(`history ${id}: dropped partial last record (~${bytes} bytes)`)
	} else if (existsSync(path)) {
		let last = history.lastByte(path)
		if (last !== undefined && last !== 10) appendFileSync(path, '\n')
	}
	return meta
}

async function messages(id: string) {
	return replay.toMessages(await history.read(id))
}

// One provider round of a turn. Passes stream events through,
// appending each assistant block as soon as it is complete (and the
// rest when the consumer stops early). A stream that throws ends as an
// error, yielded like any other error event. The turn stays running,
// through tool calls and later rounds, until end().
async function* record(id: string, providerName: string, events: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
	let before = history.state.running.get(id)
	let prior = before ? addUsage(before.prior, before.turn.usage) : {}
	let running: Running = { turn: blocks.newTurn(providerName), written: 0, prior }
	let { turn } = running
	let flush = (upTo: number) => {
		if (running.ended) return
		for (; running.written < upTo; running.written++) history.append(id, { type: 'assistant', block: turn.blocks[running.written]! })
	}
	history.state.running.set(id, running)
	try {
		for await (let event of events) {
			blocks.apply(turn, event)
			flush(turn.blocks.length - 1)
			if (turn.end) break
			yield event
		}
	} catch (e: any) {
		turn.end = { type: 'error', message: String(e?.message ?? e) }
	} finally {
		flush(turn.blocks.length)
	}
	if (turn.end && !running.ended) yield turn.end
}

// Records the results of a round's tool calls, unless the turn has
// already ended (stop()).
function results(id: string, list: ToolResultBlock[]): void {
	if (history.state.running.has(id)) history.append(id, { type: 'user', blocks: list })
}

// Ends the running turn, with the usage of all its rounds: `last` is
// how its last round ended (none, or cancelled: the user paused it).
// Does nothing for a turn not running here, or already ended.
function end(id: string, last: DoneEvent | ErrorEvent | undefined): void {
	let running = history.state.running.get(id)
	if (!running) return
	history.state.running.delete(id)
	let usage = addUsage(running.prior, running.turn.usage)
	if (last?.type === 'done') history.append(id, { type: 'turn_end', status: 'completed', reason: last.reason, usage })
	else if (last?.type === 'error' && !last.cancelled) history.append(id, { type: 'turn_end', status: 'error', error: last.message, usage })
	else history.append(id, { type: 'turn_end', status: 'paused', usage })
}

// Stops recording the running turn without ending it: it asked a
// question and waits, unfinished, with nothing in memory. The answer
// runs it again. Returns the usage of its rounds so far, which the
// caller keeps in history for the turn to go on from (carry).
function park(id: string): Usage {
	let running = history.state.running.get(id)
	history.state.running.delete(id)
	return running ? addUsage(running.prior, running.turn.usage) : {}
}

// Starts recording a turn that already used `usage` (the rounds before
// it was parked), so its end counts them. A turn carried but ended
// before any round (held tool calls, then a pause) still gets its end.
function carry(id: string, providerName: string, usage: Usage): void {
	history.state.running.set(id, { turn: blocks.newTurn(providerName), written: 0, prior: { ...usage } })
}

// For a host about to exit: writes every running turn's output so far
// and stops recording it. With `pause` (Ctrl-C of the last Hal process)
// each turn is ended as paused; otherwise it is left unfinished, for the
// next host to continue. Synchronous, so it can run in a process 'exit'
// handler, before the host lock is released to a successor.
function stop(pause: boolean): void {
	for (let [id, running] of history.state.running) {
		history.state.running.delete(id)
		if (running.ended) continue
		running.ended = true
		let { turn } = running
		try {
			for (; running.written < turn.blocks.length; running.written++) history.append(id, { type: 'assistant', block: turn.blocks[running.written]! })
			if (pause) history.append(id, { type: 'turn_end', status: 'paused', usage: addUsage(running.prior, turn.usage) })
		} catch (e: any) {
			diag.log(`history ${id}: could not record the stopped turn: ${e?.message ?? e}`)
		}
	}
}

// The running turn's output not yet in history: the current round's
// last, unfinished block (if any) and that round's usage so far.
function live(id: string): Turn | undefined {
	let running = history.state.running.get(id)
	if (!running) return undefined
	let { turn, written } = running
	return { provider: turn.provider, blocks: turn.blocks.slice(written), usage: { ...turn.usage } }
}

// One single-round model turn for an open session, from its history
// and model, ended however the consumer stops. Tool calls are left
// unanswered; the host's turns run them (host.ts).
async function* turn(id: string, opts: Omit<ProviderRequest, 'model' | 'messages'> = {}, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
	let modelId = sessions.open(id).model
	let input = { ...opts, messages: await history.messages(id), image: (blob: string) => blobs.base64(id, blob) }
	let providerName = blocks.parseModelId(modelId)?.provider ?? modelId
	let last: DoneEvent | ErrorEvent | undefined
	try {
		for await (let event of history.record(id, providerName, provider.stream(modelId, input, signal))) {
			if (event.type === 'done' || event.type === 'error') last = event
			yield event
		}
	} finally {
		history.end(id, last)
	}
}

export const history = {
	// Sessions with a turn running in this host, and its current round.
	state: { running: new Map<string, Running>() },
	check,
	file,
	append,
	submit,
	load,
	lastByte,
	read,
	readSync,
	tail,
	unfinished,
	open,
	messages,
	record,
	results,
	end,
	park,
	carry,
	stop,
	live,
	turn,
}
