// Imports the old Hal's sessions into a hal2 home (task 3q). Run by hand
// (scripts/import-old); nothing on the host path calls it. Each old
// session becomes one hal2 session with the same id whose history holds
// what the old Hal showed and sent: its current log, after the fork
// parent's records from before the fork (the old loadAllHistory), with
// blob contents written inline. Old formats: ~/.hal/src/common/history.ts.

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync, appendFileSync } from 'fs'
import { ason } from './common/ason.ts'
import { lines } from './common/lines.ts'
import { attachments } from './common/attachments.ts'
import type { HistoryRecord, TurnStatus } from './common/replay.ts'
import type { UserBlock } from './common/blocks.ts'

type Old = Record<string, any>
type Rec = HistoryRecord & { ts?: string }
export type Counts = { sessions: number; open: number; records: number; bytes: number; dropped: Record<string, number> }

const statuses: Record<string, TurnStatus> = { completed: 'completed', aborted: 'paused', stopped: 'paused', failed: 'error', error: 'error', paused: 'paused' }
// Old records that carry nothing the transcript or the model needs.
const dropped = new Set(['usage', 'input_history', 'pending_tools', 'forked_to', 'rebased_from', 'rebased_to', 'session'])

function readAson(path: string): Old | undefined {
	try {
		return ason.parse(readFileSync(path, 'utf8')) as Old
	} catch {
		return undefined
	}
}

// One record per line; a line that does not parse (a torn write) is skipped.
function readLog(path: string): Old[] {
	if (!existsSync(path)) return []
	let out: Old[] = []
	for (let line of readFileSync(path, 'utf8').split('\n')) {
		if (!line.trim()) continue
		try {
			out.push(ason.parse(line) as Old)
		} catch {}
	}
	return out
}

function firstLine(path: string): Old | undefined {
	if (!existsSync(path)) return undefined
	let fd = openSync(path, 'r')
	let buf = Buffer.alloc(4096)
	let got = readSync(fd, buf, 0, buf.length, 0)
	closeSync(fd)
	try {
		return ason.parse(buf.subarray(0, got).toString('utf8').split('\n')[0]!) as Old
	} catch {
		return undefined
	}
}

function importOld(oldState: string, home: string): Counts {
	let oldDir = `${oldState}/sessions`
	let newDir = `${home}/sessions`
	if (existsSync(newDir) && readdirSync(newDir).length) throw new Error(`${newDir} already has sessions`)
	let ids = readdirSync(oldDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
	let metas = new Map(ids.map((id) => [id, readAson(`${oldDir}/${id}/session.ason`) ?? {}]))
	let logOf = (id: string) => `${oldDir}/${id}/${metas.get(id)?.currentLog ?? 'history.asonl'}`
	let parentOf = new Map<string, string>()
	for (let id of ids) {
		let first = firstLine(logOf(id))
		if (first?.type === 'forked_from' && typeof first.parent === 'string') parentOf.set(id, first.parent)
	}
	let parents = new Set(parentOf.values())
	let cache = new Map<string, Rec[]>()
	let counts: Counts = { sessions: 0, open: 0, records: 0, bytes: 0, dropped: {} }
	// Image blob id → where its bytes were written, for fork children.
	let images = new Map<string, string>()

	let blobOf = (id: string, blobId: string | undefined, seen = new Set<string>()): Old | undefined => {
		if (!blobId || seen.has(id)) return undefined
		seen.add(id)
		let path = `${oldDir}/${id}/blobs/${blobId}.ason`
		if (existsSync(path)) return readAson(path)
		let parent = parentOf.get(id)
		return parent ? blobOf(parent, blobId, seen) : undefined
	}

	// The records of `id` as the old Hal loaded them, fork prefix first.
	let load = (id: string, chain: string[] = []): Rec[] => {
		let hit = cache.get(id)
		if (hit) return hit
		let old = readLog(logOf(id))
		let prefix: Rec[] = []
		let parent = parentOf.get(id)
		let forkTs = old[0]?.type === 'forked_from' ? old[0].ts : undefined
		if (parent && metas.has(parent) && !chain.includes(parent)) {
			let all = load(parent, [...chain, id])
			prefix = forkTs ? all.filter((r) => !r.ts || r.ts < forkTs) : all
		}
		let own = convert(id, old)
		if (parent) own.unshift({ type: 'output', text: `Forked from ${parent}.`, ts: forkTs } as Rec)
		let recs = [...prefix, ...own]
		if (parents.has(id)) cache.set(id, recs)
		return recs
	}

	let convert = (id: string, old: Old[]): Rec[] => {
		let out: Rec[] = []
		let pending = new Set<string>()
		let deferred: Rec[] = []
		let model: string | undefined = metas.get(id)?.model
		let push = (r: Rec) => (pending.size ? deferred : out).push(r)
		let flush = () => {
			out.push(...deferred)
			deferred = []
		}
		for (let e of old) {
			let ts = typeof e.ts === 'string' ? e.ts : undefined
			if (e.type === 'user') {
				let blocks: UserBlock[] = []
				for (let p of e.parts ?? []) {
					if (p.type === 'text' && typeof p.text === 'string') {
						blocks.push(e.source ? { type: 'text', text: p.text, from: String(e.source), label: [e.sourceTab, e.source, e.sourceName].filter((x) => x !== undefined).join(' ') } : { type: 'text', text: p.text })
					} else if (p.type === 'image') {
						let data = blobOf(id, p.blobId)
						let ext = attachments.types[data?.media_type]
						if (!ext || typeof data?.data !== 'string') {
							blocks.push({ type: 'text', text: `[image unavailable — blob ${p.blobId}]` })
							continue
						}
						let bytes = Buffer.from(data.data, 'base64')
						let dir = `${newDir}/${id}/blobs`
						mkdirSync(dir, { recursive: true })
						let path = `${dir}/${p.blobId}.${ext}`
						writeFileSync(path, bytes, { mode: 0o600 })
						images.set(p.blobId, path)
						blocks.push({ type: 'image', blob: p.blobId, mediaType: data.media_type, bytes: bytes.length })
					}
				}
				if (blocks.length) push({ type: 'user', blocks, ts } as Rec)
			} else if (e.type === 'thinking') {
				let b = blobOf(id, e.blobId)
				let text = e.text ?? b?.thinking ?? ''
				let signature = e.signature ?? b?.signature
				let m = e.model ?? model
				let provider = typeof m === 'string' ? m.split('/')[0] : undefined
				let block = { type: 'thinking', text, ...(signature ? { signature } : {}), ...(provider ? { provider } : {}) }
				out.push({ type: 'assistant', block, ...(m ? { model: m } : {}), ...(e.thinkingEffort ? { effort: e.thinkingEffort } : {}), ts } as Rec)
			} else if (e.type === 'assistant') {
				if (e.synthetic || e.visibility === 'ui') push({ type: 'output', text: String(e.text ?? ''), ts } as Rec)
				else if (e.text) out.push({ type: 'assistant', block: { type: 'text', text: String(e.text) }, ...(e.model ? { model: e.model } : {}), ts } as Rec)
				if (e.model) model = e.model
			} else if (e.type === 'tool_call') {
				if (e.visibility === 'ui') continue
				let input = e.input ?? blobOf(id, e.blobId)?.call?.input ?? {}
				pending.add(e.toolId)
				out.push({ type: 'assistant', block: { type: 'tool_call', id: e.toolId, name: e.name, input: typeof input === 'object' && input ? input : { input } }, ts } as Rec)
			} else if (e.type === 'tool_result') {
				if (e.visibility === 'ui' || !pending.has(e.toolId)) continue
				let result = blobOf(id, e.blobId)?.result
				let output = e.output ?? result?.content ?? '[interrupted]'
				let block = { type: 'tool_result' as const, id: e.toolId, output: typeof output === 'string' ? output : ason.stringify(output), ...(e.isError || result?.status === 'error' ? { isError: true } : {}) }
				let last = out.at(-1)
				if (last?.type === 'user' && last.blocks.every((x) => x.type === 'tool_result')) last.blocks.push(block)
				else out.push({ type: 'user', blocks: [block], ts } as Rec)
				pending.delete(e.toolId)
				if (!pending.size) flush()
			} else if (e.type === 'turn_end') {
				pending.clear()
				flush()
				out.push({ type: 'turn_end', status: statuses[e.status] ?? 'paused', usage: {}, ts } as Rec)
			} else if (e.type === 'reset' || e.type === 'compact') {
				out.push({ type: 'reset', ts } as Rec)
			} else if (e.type === 'cwd' || e.type === 'model') {
				if (e.type === 'model') model = e.to
				push({ type: 'change', [e.type]: e.to, ts } as Rec)
			} else if (e.type === 'info' || e.type === 'log' || e.type === 'warning' || e.type === 'error') {
				push({ type: 'output', text: String(e.text ?? ''), ...(e.type === 'error' ? { error: true } : {}), ts } as Rec)
			} else if (e.type === 'question') {
				push({ type: 'output', text: String(e.text ?? ''), ts } as Rec)
			} else if (e.type === 'answer') {
				let v = e.value ?? {}
				let text = v.kind === 'text' ? v.text : v.kind === 'choice' ? v.choiceId : v.kind === 'aborted' ? '(no answer)' : '(secret)'
				push({ type: 'output', text: `→ ${text}`, ts } as Rec)
			} else if (e.type !== 'forked_from') {
				counts.dropped[e.type] = (counts.dropped[e.type] ?? 0) + (dropped.has(e.type) ? 0 : 1)
			}
		}
		flush()
		return out
	}

	for (let id of ids) {
		let meta = metas.get(id)!
		let recs = load(id)
		let dir = `${newDir}/${id}`
		mkdirSync(dir, { recursive: true })
		// Every history ends idle: a turn with no end would be continued
		// by the first host (turns.recover), running the model unasked.
		let lastEnd = recs.findLastIndex((r) => r.type === 'turn_end')
		if (recs.slice(lastEnd + 1).some((r) => r.type === 'user' || r.type === 'assistant')) recs = [...recs, { type: 'turn_end', status: 'paused', usage: {} } as Rec]
		let ts = typeof meta.createdAt === 'string' ? meta.createdAt : new Date(0).toISOString()
		let chunks: string[] = []
		let n = 0
		let size = 0
		let path = `${dir}/history.asonl`
		writeFileSync(path, '')
		for (let r of recs) {
			ts = r.ts ?? ts
			let line = lines.encode({ ...r, n: ++n, ts })
			chunks.push(line)
			size += line.length
			if (size > 1 << 22) {
				appendFileSync(path, chunks.join(''))
				chunks = []
				size = 0
			}
			counts.bytes += Buffer.byteLength(line)
			if (r.type === 'user') for (let b of r.blocks) if (b.type === 'image' && !existsSync(`${dir}/blobs/${b.blob}.${attachments.types[b.mediaType]}`)) {
				let from = images.get(b.blob)
				if (from) {
					mkdirSync(`${dir}/blobs`, { recursive: true })
					copyFileSync(from, `${dir}/blobs/${b.blob}.${attachments.types[b.mediaType]}`)
				}
			}
		}
		appendFileSync(path, chunks.join(''))
		counts.records += n
		let session = {
			id,
			cwd: typeof meta.workingDir === 'string' ? meta.workingDir : home,
			model: typeof meta.model === 'string' ? meta.model : 'anthropic/claude-opus-4-6',
			...(typeof meta.name === 'string' ? { name: meta.name } : {}),
			createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : ts,
		}
		writeFileSync(`${dir}/session.ason`, ason.stringify(session) + '\n')
		counts.sessions++
	}
	let listed = (readAson(`${oldState}/ipc/state.ason`)?.sessions ?? []) as Old[]
	let open = listed.map((s) => s?.id).filter((id): id is string => typeof id === 'string' && metas.has(id))
	mkdirSync(`${home}/state`, { recursive: true })
	writeFileSync(`${home}/state/tabs.ason`, ason.stringify({ open, closed: [], attention: [] }) + '\n')
	counts.open = open.length
	for (let k of Object.keys(counts.dropped)) if (!counts.dropped[k]) delete counts.dropped[k]
	return counts
}

export const importer = { importOld }

if (import.meta.main) {
	let [oldState, home] = process.argv.slice(2)
	if (!oldState || !home) {
		console.error('usage: scripts/import-old <old-state> <new-home>')
		process.exit(2)
	}
	let t0 = performance.now()
	let c = importer.importOld(oldState, home)
	console.log(`${c.sessions} sessions (${c.open} open), ${c.records} records, ${(c.bytes / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
	if (Object.keys(c.dropped).length) console.log(`unknown record types skipped: ${Object.entries(c.dropped).map(([k, v]) => `${k} ${v}`).join(', ')}`)
}
