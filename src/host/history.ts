// Durable conversation history: sessions/<id>/history.asonl, one record
// per line (src/common/replay.ts), appended as the conversation happens.
// Provider input for every turn is rebuilt from this file alone.
//
// Opening a session repairs its history: a partially written last record
// (the host died mid-write) is cut off. Any other malformed record is
// reported and the file is left untouched. A turn with no end record is
// unfinished, not broken: the host continues it (turns.recover).
// Tasks: 7, nvm, 6eq.

import { appendFileSync, existsSync, openSync, readSync as readFd, closeSync, statSync, truncateSync } from 'fs'
import { historyCheck } from './history-check.ts'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import { blocks, type DoneEvent, type ErrorEvent, type StreamEvent, type ThinkingBlock, type ToolResultBlock, type Turn, type Usage, type UserBlock } from '../common/blocks.ts'
import { modelNotices } from '../common/model-notices.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { blobs } from './blobs.ts'
import { busy } from './busy.ts'
import { diag } from './diag.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { pruning } from './pruning.ts'
import { models } from './models.ts'
import { sessions, type SessionMeta } from './sessions.ts'
import { naming } from './naming.ts'
import { neighbors } from './neighbors.ts'

type NewRecord = HistoryRecord extends infer R ? (R extends HistoryRecord ? Omit<R, 'ts'> : never) : never

// One running turn: its current provider round (`turn`), how many of
// that round's blocks are on disk, and the usage of earlier rounds.
// `ended`: stop() has written its last record; nothing more is written.
// `ns`: each block's record number, given when it started streaming.
// `context`: what the latest earlier round with usage took in.
// `by`: the model and effort writing the turn; `starts`: when each
// block (by `ns` index) started, its record's ts (task hp).
type Running = { turn: Turn; written: number; prior: Usage; ended?: boolean; ns: number[]; starts: string[]; by: By; context?: number; interrupted?: true }
export type By = { model?: string; effort?: string }

// The tokens a round took in: input, cache read and cache write.
function taken(u: Usage): number {
	return (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
}

// What the running turn's latest round with usage took in, if any.
function contextOf(r: Running): { context?: number } {
	let c = taken(r.turn.usage) || r.context
	return c ? { context: c } : {}
}

function addUsage(a: Usage, b: Usage): Usage {
	let sum = { ...a }
	for (let [k, v] of Object.entries(b)) if (v !== undefined) sum[k as keyof Usage] = (sum[k as keyof Usage] ?? 0) + v
	return sum
}
function file(id: string): string {
	return `${paths.sessionDir(id)}/history.asonl`
}

// The session's next record number (HistoryRecord `n`), taken: past
// every record in the file and every number given out meanwhile (a
// block still streaming holds one).
function number(id: string): number {
	let path = history.file(id)
	let n = Math.max(history.state.next.get(path) ?? 1, pages.marks(id).next ?? 1)
	history.state.next.set(path, n + 1)
	return n
}

// Appends the record, numbered (`n`: a number taken before, for a
// streamed block), and returns it as written. Keeps the busy list
// (busy.ts) in step: joined before the record that may leave work, left
// after a turn end with an empty inbox.
// `ts`: when it happened, if not now (a streamed block's start).
function append(id: string, record: NewRecord & { ts?: string }): HistoryRecord {
	let { n, ts, ...rest } = record
	let full = { ...rest, n: n ?? history.number(id), ts: ts ?? new Date().toISOString() } as HistoryRecord
	let line = lines.encode(full)
	if (busy.starts(full)) busy.add(id)
	history.write(history.file(id), line)
	pages.note(id, line, full)
	naming.committed(id, full)
	if (full.type === 'turn_end' && !Object.keys(pages.marks(id).inbox).length && !pages.marks(id).transitions?.length) busy.drop(id)
	for (let listener of history.state.listeners) listener(id, full)
	return full
}

// Appends one whole line or nothing: a failed write (ENOSPC) is cut
// back to the old size before it rethrows, so a later append never
// joins a torn record mid-file (task ncy). Shrinking needs no space.
function write(path: string, line: string): void {
	let size = existsSync(path) ? statSync(path).size : 0
	try { appendFileSync(path, line) } catch (e) { try { truncateSync(path, size) } catch {} throw e }
}

// Calls `listener` after every durable append (find.ts indexes them);
// returns the unsubscribe. Listeners must stay cheap: appends are sync.
function onAppend(listener: (id: string, record: HistoryRecord) => void): () => void {
	history.state.listeners.add(listener)
	return () => history.state.listeners.delete(listener)
}

// `command`: the client's id for the submit, so a resend is recognized.
function submit(id: string, prompt: string | UserBlock[], command?: string): HistoryRecord {
	let content = typeof prompt === 'string' ? [{ type: 'text' as const, text: prompt }] : prompt
	let record = { type: 'user' as const, blocks: content, ...(command !== undefined && { command }) }
	naming.prepare(id, record as Extract<HistoryRecord, { type: 'user' }>)
	return history.append(id, record)
}

async function load(id: string): Promise<{ records: HistoryRecord[]; partial?: string }> {
	let path = history.file(id)
	if (!existsSync(path)) return { records: [] }
	let records: HistoryRecord[] = []
	let partial: string | undefined
	try {
		let text = await Bun.file(path).text()
		let end = text.lastIndexOf('\n') + 1
		for (let line of text.slice(0, end).split('\n')) if (line.trim()) records.push(history.check(ason.parse(line)))
		// An unterminated last line that fails to parse is a torn write.
		let tail = text.slice(end)
		if (tail.trim()) {
			let value: unknown
			try {
				value = ason.parse(tail)
			} catch {
				partial = tail
			}
			if (partial === undefined) records.push(history.check(value))
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
// this process only a crash leaves a partial line; it is skipped. An
// open session's records stay in memory (provider input is rebuilt from
// them every round): only what was appended since is read.
function readSync(id: string): HistoryRecord[] {
	let path = history.file(id)
	for (let key of history.state.cache.keys()) if (!sessions.state.open.has(key)) history.state.cache.delete(key)
	if (!existsSync(path)) return []
	let size = statSync(path).size
	let cached = history.state.cache.get(id)
	if (!cached || cached.size > size) cached = { size: 0, records: [] }
	let buf = pages.readBytes(path, cached.size, size)
	let end = buf.lastIndexOf(10) + 1
	let records = [...cached.records, ...pages.lines(path, buf.subarray(0, end), cached.size).map((l) => l.record)]
	if (sessions.state.open.has(id)) history.state.cache.set(id, { size: cached.size + end, records })
	let last = buf.toString('utf8', end)
	if (last.trim()) {
		try {
			let r = history.check(ason.parse(last))
			r.n ??= cached.size + end + 1
			return [...records, r]
		} catch {}
	}
	return records.slice()
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

// True if the last turn has no end record. Reads the marks (pages.ts),
// not the history, so it costs the same however long the session is.
function unfinished(id: string): boolean {
	let at = pages.marks(id).turn
	return at !== undefined && pages.lineAt(history.file(id), at).record.type !== 'turn_end'
}

// Opens the session and repairs its history so appends land cleanly:
// only its end is read. A malformed record further back is reported
// when it is read, and the file left untouched.
async function open(id: string): Promise<SessionMeta> {
	let meta = sessions.open(id)
	let path = history.file(id)
	let size = existsSync(path) ? statSync(path).size : 0
	if (!size || history.lastByte(path) === 10) return meta
	let from = size
	let buf = Buffer.alloc(0)
	while (from > 0 && buf.indexOf(10) < 0) {
		let n = Math.min(from, Math.max(65536, buf.length))
		buf = Buffer.concat([pages.readBytes(path, from - n, from), buf])
		from -= n
	}
	let nl = buf.lastIndexOf(10)
	let last = buf.toString('utf8', nl + 1)
	try {
		history.check(ason.parse(last))
		appendFileSync(path, '\n')
	} catch {
		truncateSync(path, from + nl + 1)
		history.state.cache.delete(id)
		diag.log(`history ${id}: dropped partial last record (~${Buffer.byteLength(last)} bytes)`)
	}
	return meta
}

// The session as provider messages, each prompt's paste markers
// expanded to the pasted text (blobs.expand): history keeps markers.
async function messages(id: string, budget: { overhead?: number; window?: number; model?: string } = {}) {
	for (let text of neighbors.notes(id, sessions.open(id).cwd)) history.append(id, { type: 'notice', text })
	// A thinking block as the provider sent it: its signature back from its blob.
	let signed = ({ signatureBlob, ...b }: ThinkingBlock): ThinkingBlock => ({ ...b, signature: blobs.text(id, signatureBlob!) })
	let records = pruning.project(id, history.readSync(id), budget, (r) => r.type === 'user' ? { ...r, blocks: r.blocks.map((b) => b.type === 'text' && /\[(?:paste|file)[/ ]/.test(b.text) ? { ...b, text: blobs.expand(id, b.text) } : b) }
		: r.type === 'assistant' && r.block.type === 'thinking' && r.block.signatureBlob !== undefined ? { ...r, block: signed(r.block) } : r)
	let due = modelNotices.pending(replay.current(records))
	if (due.length) records.push(history.append(id, { type: 'user', blocks: [], notices: due }))
	return replay.toMessages(records)
}

// One provider round of a turn. Passes stream events through,
// appending each assistant block as soon as it is complete (and the
// rest when the consumer stops early). A stream that throws ends as an
// error, yielded like any other error event. The turn stays running,
// through tool calls and later rounds, until end().
async function* record(id: string, providerName: string, events: AsyncIterable<StreamEvent>, by: By = {}, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
	let before = history.state.running.get(id)
	let inputRecords = history.readSync(id)
	let prior = before ? addUsage(before.prior, before.turn.usage) : {}
	let running: Running = { turn: blocks.newTurn(providerName), written: 0, prior, ns: [], starts: [], by, ...(before && contextOf(before)) }
	let { turn } = running
	let flush = (upTo: number) => {
		if (running.ended) return
		for (; running.written < upTo; running.written++) history.append(id, history.blockRecord(id, running, running.written))
	}
	history.state.running.set(id, running)
	try {
		for await (let event of events) {
			if (signal?.aborted) break
			blocks.apply(turn, event)
			while (running.ns.length < turn.blocks.length) {
				running.ns.push(history.number(id))
				running.starts.push(new Date().toISOString())
			}
			flush(turn.blocks.length - 1)
			if (turn.end) break
			yield event
		}
	} catch (e: any) {
		turn.end = { type: 'error', message: String(e?.message ?? e) }
	} finally {
		if (signal?.aborted && turn.end?.type !== 'done' && turn.blocks.at(-1)?.type === 'text') running.interrupted = true
		flush(turn.blocks.length)
		if (!running.ended && Object.keys(turn.usage).length) history.append(id, { type: 'round', usage: { ...turn.usage }, ...(by.model !== undefined && { model: by.model }), ...(turn.account && { account: turn.account }), ...(running.ns[0] !== undefined && { block: running.ns[0] }) })
		if (turn.end?.type === 'done') pruning.consumed(id, inputRecords)
	}
	if (turn.end && !running.ended) yield turn.end
}

// The record of the running turn's block `i`: started when it did, by
// the turn's model and effort. A thinking signature goes to a blob.
function blockRecord(id: string, running: Running, i: number): NewRecord & { ts?: string } {
	let block = running.turn.blocks[i]!
	if (block.type === 'thinking' && block.signature) { let { signature, ...rest } = block; block = { ...rest, signatureBlob: blobs.storeOutput(id, signature).blob } }
	let r: NewRecord & { type: 'assistant'; ts?: string } = { type: 'assistant', block, n: running.ns[i]! }
	if (running.interrupted && i === running.turn.blocks.length - 1) r.interrupted = true
	if (running.by.model !== undefined) r.model = running.by.model
	if (running.by.effort !== undefined) r.effort = running.by.effort
	if (running.starts[i] !== undefined) r.ts = running.starts[i]
	return r
}

// Only the current round can report interruption (task 6eq). The full
// record also reconciles a final delta the host did not broadcast.
function interrupted(id: string): Extract<HistoryRecord, { type: 'assistant' }> | undefined {
	let r = history.state.running.get(id)
	if (!r?.interrupted) return
	return history.blockRecord(id, r, r.turn.blocks.length - 1) as Extract<HistoryRecord, { type: 'assistant' }>
}

// Records the results of a round's tool calls, unless the turn has
// already ended (stop()).
function results(id: string, list: ToolResultBlock[]): HistoryRecord | undefined {
	if (history.state.running.has(id)) return history.append(id, { type: 'user', blocks: list })
}

// A failed turn's error as stored and shown: the message, then the provider's
// body (malformed input, HTTP reply) unless the message holds it. Never truncated.
const errorText = (e: ErrorEvent): string => (e.body?.trim() && !e.message.includes(e.body.trim()) ? `${e.message}\n${e.body.trim()}` : e.message)

// Ends the running turn, with the usage of all its rounds: `last` is
// how its last round ended (none, or canceled: the user paused it).
// Does nothing for a turn not running here, or already ended.
// `pauseReason`: why Hal, not the user, paused a turn that ended paused.
function end(id: string, last: DoneEvent | ErrorEvent | undefined, pauseReason?: string): void {
	let running = history.state.running.get(id)
	if (!running) return
	history.state.running.delete(id)
	let usage = addUsage(running.prior, running.turn.usage)
	let context = contextOf(running)
	if (last?.type === 'done') history.append(id, { type: 'turn_end', status: 'completed', reason: last.reason, usage, ...context })
	else if (last?.type === 'error' && !last.canceled) history.append(id, { type: 'turn_end', status: 'error', error: errorText(last), usage, ...context })
	else history.append(id, { type: 'turn_end', status: 'paused', usage, ...context, ...(pauseReason !== undefined && { pauseReason }) })
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
	history.state.running.set(id, { turn: blocks.newTurn(providerName), written: 0, prior: { ...usage }, ns: [], starts: [], by: {} })
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
			for (; running.written < turn.blocks.length; running.written++) history.append(id, history.blockRecord(id, running, running.written))
			if (pause) history.append(id, { type: 'turn_end', status: 'paused', usage: addUsage(running.prior, turn.usage), ...contextOf(running) })
		} catch (e: any) {
			diag.log(`history ${id}: could not record the stopped turn: ${e?.message ?? e}`)
		}
	}
}

// The running turn's output not yet in history: the current round's
// last, unfinished block (if any), its number and that round's usage
// so far.
function live(id: string): (Turn & { ns: number[]; ts: string[] }) | undefined {
	let running = history.state.running.get(id)
	if (!running) return undefined
	let { turn, written } = running
	return { provider: turn.provider, blocks: turn.blocks.slice(written), usage: { ...turn.usage }, ns: running.ns.slice(written), ts: running.starts.slice(written) }
}

// The number of the block the running turn streams into, if any.
function streaming(id: string): number | undefined {
	return history.state.running.get(id)?.ns.at(-1)
}

// When the block streaming now started, as its record will say.
function started(id: string): string | undefined {
	return history.state.running.get(id)?.starts.at(-1)
}

// One single-round model turn for an open session, from its history
// and model, ended however the consumer stops. Tool calls are left
// unanswered; the host's turns run them (host.ts).
async function* turn(id: string, opts: Omit<ProviderRequest, 'model' | 'messages'> = {}, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
	let modelId = sessions.open(id).model
	let input = { ...opts, messages: await history.messages(id, { overhead: (opts.system?.length ?? 0) + JSON.stringify(opts.tools ?? []).length, window: models.contextWindow(modelId), model: modelId }), image: (blob: string) => blobs.base64(id, blob) }
	let providerName = blocks.parseModelId(modelId)?.provider ?? modelId
	let last: DoneEvent | ErrorEvent | undefined
	try {
		for await (let event of history.record(id, providerName, provider.stream(modelId, input, signal), { model: modelId }, signal)) {
			if (event.type === 'done' || event.type === 'error') last = event
			yield event
		}
	} finally {
		history.end(id, last)
	}
}

export const history = {
	// Sessions with a turn running in this host, and its current round.
	// `cache`: each open session's complete records and the bytes they
	// fill, kept while it is open. `next`: by history file, the next
	// record number not given out yet. `listeners`: see onAppend.
	state: { running: new Map<string, Running>(), cache: new Map<string, { size: number; records: HistoryRecord[] }>(), next: new Map<string, number>(), listeners: new Set<(id: string, record: HistoryRecord) => void>() },
	check: (value: unknown) => historyCheck.check(value),
	blockRecord, started, number, file, append, write, onAppend, submit, load, lastByte, read, readSync,
	unfinished, open, messages, record, interrupted, results, end, park, carry, stop, live, streaming, turn,
}
