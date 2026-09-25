// Durable conversation history: sessions/<id>/history.asonl, one record
// per line (src/common/replay.ts), appended as the conversation happens.
// Provider input for every turn is rebuilt from this file alone.
//
// Opening a session repairs its history: a partially written last record
// (the host died mid-write) is cut off, and a turn that never ended is
// closed as interrupted. Any other malformed record is reported and the
// file is left untouched.

import { appendFileSync, existsSync, openSync, readFileSync, readSync as readFd, closeSync, statSync, truncateSync } from 'fs'
import { ason } from '../common/ason.ts'
import { blocks, type StreamEvent, type Turn, type UserBlock } from '../common/blocks.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { diag } from './diag.ts'
import { paths } from './paths.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { sessions, type SessionMeta } from './sessions.ts'

type NewRecord = HistoryRecord extends infer R ? (R extends HistoryRecord ? Omit<R, 'ts'> : never) : never

const recordTypes = new Set(['user', 'assistant', 'turn_end'])

type Running = { turn: Turn; written: number }

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

function submit(id: string, prompt: string | UserBlock[]): void {
	let content = typeof prompt === 'string' ? [{ type: 'text' as const, text: prompt }] : prompt
	history.append(id, { type: 'user', blocks: content })
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
	if (!history.state.running.has(id) && replay.openTurn(loaded.records)) {
		history.append(id, { type: 'turn_end', status: 'interrupted', usage: {} })
	}
	return meta
}

async function messages(id: string) {
	return replay.toMessages(await history.read(id))
}

// Passes stream events through, appending each assistant block as soon
// as it is complete and a turn end last. A consumer that stops early
// ends the turn as cancelled; a stream that throws ends it as an error,
// yielded like any other error event.
async function* record(id: string, providerName: string, events: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
	let running: Running = { turn: blocks.newTurn(providerName), written: 0 }
	let { turn } = running
	let flush = (upTo: number) => {
		for (; running.written < upTo; running.written++) history.append(id, { type: 'assistant', block: turn.blocks[running.written]! })
	}
	history.state.running.set(id, running)
	try {
		try {
			for await (let event of events) {
				blocks.apply(turn, event)
				flush(turn.blocks.length - 1)
				if (turn.end) break
				yield event
			}
		} catch (e: any) {
			turn.end = { type: 'error', message: String(e?.message ?? e) }
		}
	} finally {
		try {
			flush(turn.blocks.length)
			let end = turn.end
			let usage = turn.usage
			if (end?.type === 'done') history.append(id, { type: 'turn_end', status: 'completed', reason: end.reason, usage })
			else if (end?.type === 'error' && !end.cancelled) history.append(id, { type: 'turn_end', status: 'error', error: end.message, usage })
			else history.append(id, { type: 'turn_end', status: 'cancelled', usage })
		} finally {
			history.state.running.delete(id)
		}
	}
	if (turn.end) yield turn.end
}

// The running turn's output not yet in history: its last, unfinished
// block (if any) and the usage so far.
function live(id: string): Turn | undefined {
	let running = history.state.running.get(id)
	if (!running) return undefined
	let { turn, written } = running
	return { provider: turn.provider, blocks: turn.blocks.slice(written), usage: { ...turn.usage } }
}

// One model turn for an open session, from its history and model.
async function* turn(id: string, opts: Omit<ProviderRequest, 'model' | 'messages'> = {}, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
	let modelId = sessions.open(id).model
	let input = { ...opts, messages: await history.messages(id) }
	let providerName = blocks.parseModelId(modelId)?.provider ?? modelId
	yield* history.record(id, providerName, provider.stream(modelId, input, signal))
}

export const history = {
	// Sessions with a turn streaming in this host.
	state: { running: new Map<string, Running>() },
	check,
	file,
	append,
	submit,
	load,
	lastByte,
	read,
	readSync,
	open,
	messages,
	record,
	live,
	turn,
}
