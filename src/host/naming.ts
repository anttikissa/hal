// Host-owned naming; no model requests or autonomous turns.
import { readdirSync, existsSync, createReadStream } from 'fs'
import { ason } from '../common/ason.ts'
import { names } from '../common/names.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { sessions } from './sessions.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'

function save(id: string): void {
	let meta = sessions.open(id)
	liveFiles.save(meta)
	host.broadcast(id, { type: 'meta', sessionId: id, meta: { ...meta } })
}
function manual(id: string, text?: string): void {
	let meta = sessions.open(id)
	meta.name = text === undefined ? names.fallback(id) : names.validate(text)
	meta.nameOwner = text === undefined ? 'auto' : 'manual'
	meta.nameVersion = (meta.nameVersion ?? 0) + 1
	if (text === undefined) meta.nameTurns = 0
	naming.save(id)
}
function prepare(id: string, record: Extract<HistoryRecord, { type: 'user' }>): void {
	let text = record.blocks.slice(record.inbox?.length ?? 0).find((b) => b.type === 'text' && b.from === undefined && b.text.trim())
	if (!text || text.type !== 'text') return
	let meta = sessions.open(id)
	if (meta.nameOwner !== 'auto') return
	// History commits the counter with the prompt; reconcile a crash before meta saved.
	let prior = history.readSync(id).findLast((r) => r.type === 'user' && r.naming?.version === (meta.nameVersion ?? 0))
	let turn = Math.max(meta.nameTurns ?? 0, prior?.type === 'user' ? prior.naming?.turn ?? 0 : 0) + 1
	let eligible = turn <= 3 || turn % 4 === 3
	if (turn === 1) meta.name = names.excerpt(text.text, id)
	record.naming = { turn, version: meta.nameVersion ?? 0, name: meta.name!, eligible }
}
function committed(id: string, record: HistoryRecord): void {
	if (record.type !== 'user' || !record.naming) return
	sessions.open(id).nameTurns = record.naming.turn
	naming.save(id)
}
function pending(id: string): Extract<HistoryRecord, { type: 'user' }>['naming'] {
	let records = history.readSync(id)
	let at = records.findLastIndex((r) => r.type === 'turn_end' && r.status === 'completed')
	let record = records.slice(at + 1).findLast((r) => r.type === 'user' && r.naming)
	return record?.type === 'user' && record.naming?.eligible ? record.naming : undefined
}
function accept(id: string, text: string): void {
	let request = naming.pending(id)
	let meta = sessions.open(id)
	if (!request || meta.nameOwner !== 'auto' || (meta.nameVersion ?? 0) !== request.version) return
	let suffix = names.suffix(text)
	if (!suffix) return
	try { meta.name = names.validate(suffix.title) } catch { return }
	naming.save(id)
}
async function firstText(id: string, signal: AbortSignal): Promise<string> {
	let path = history.file(id)
	if (!existsSync(path)) return ''
	let { createInterface } = await import('readline')
	let input = createReadStream(path)
	let reader = createInterface({ input, crlfDelay: Infinity })
	try {
		for await (let line of reader) {
			if (signal.aborted) return ''
			if (!line.trim()) continue
			let r: HistoryRecord
			try { r = history.check(ason.parse(line)) } catch (e) { throw new Error(`${path}: ${e}`) }
			if (r.type !== 'user') continue
			let b = r.blocks.find((b) => b.type === 'text' && b.from === undefined && b.text.trim() && !b.text.trim().startsWith('/'))
			if (b?.type === 'text') return b.text
		}
		return ''
	} finally { reader.close(); input.destroy() }
}
async function backfill(say: (text: string) => void): Promise<void> {
	if (naming.state.walk) { naming.state.walk.abort(); say('naming backfill cancellation requested'); return }
	let controller = new AbortController()
	naming.state.walk = controller
	let scanned = 0, changed = 0
	try {
		let entries = existsSync(paths.sessionsDir()) ? readdirSync(paths.sessionsDir(), { withFileTypes: true }) : []
		for (let entry of entries) {
			if (controller.signal.aborted) break
			if (!entry.isDirectory()) continue
			let id = entry.name
			let wasOpen = sessions.state.open.has(id)
			let meta = sessions.open(id)
			try {
				if (meta.nameOwner === 'auto' && meta.name === names.fallback(id)) {
					let version = meta.nameVersion
					let text = await naming.firstText(id, controller.signal)
					if (!controller.signal.aborted && meta.nameOwner === 'auto' && meta.nameVersion === version) {
						meta.name = names.excerpt(text, id)
						naming.save(id); changed++
					}
				}
			} finally { if (!wasOpen) sessions.close(id) }
			scanned++
			if (scanned % 10 === 0) say(`naming backfill: ${scanned} scanned, ${changed} named`)
			await new Promise((resolve) => setImmediate(resolve))
		}
		say(`naming backfill ${controller.signal.aborted ? 'cancelled' : 'complete'}: ${scanned} scanned, ${changed} named`)
	} finally { naming.state.walk = undefined }
}
export const naming = { state: { walk: undefined as AbortController | undefined }, save, manual, prepare, committed, pending, accept, firstText, backfill }
