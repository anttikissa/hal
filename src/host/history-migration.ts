// Retire ask calls before the host accepts clients (task cs). Histories
// are rewritten atomically; no legacy reader or dead tool remains.
import { existsSync, linkSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { historyCheck } from './history-check.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

function strip(records: HistoryRecord[]): HistoryRecord[] {
	let calls = new Map<string, boolean>(), questions = new Set<string>()
	let out: HistoryRecord[] = [], removed = new Set<number>()
	for (let r of records) {
		let keep: HistoryRecord | undefined = r
		if (r.type === 'assistant' && r.block.type === 'tool_call') {
			let ask = r.block.name === 'ask'
			calls.set(r.block.id, ask)
			if (ask) keep = undefined
		} else if (r.type === 'question' && !r.from && r.call && calls.get(r.call)) {
			questions.add(r.id)
			keep = undefined
		} else if (r.type === 'answer' && questions.has(r.question)) keep = undefined
		else if (r.type === 'user') {
			let blocks = r.blocks.filter((b) => b.type !== 'tool_result' || !calls.get(b.id))
			if (blocks.length !== r.blocks.length) keep = blocks.length ? { ...r, blocks } : undefined
		}
		if (keep) out.push(keep)
		else if (r.n !== undefined) removed.add(r.n)
	}
	// Context surgery must not refer to records the migration removed.
	return out.map((r) => r.type !== 'rebase' ? r : { ...r, drop: r.drop.filter((n) => !removed.has(n)), edit: r.edit.filter((e) => !removed.has(e.n)) })
}

function migrate(path: string): boolean {
	let text = readFileSync(path, 'utf8'), records: HistoryRecord[] = []
	// Most histories never called ask; skip parsing them (sessions/ can hold gigabytes).
	if (!text.includes("'ask'")) return false
	let offset = 0, tail = ''
	for (let raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		if (!raw.trim()) { offset += Buffer.byteLength(raw); continue }
		let value: unknown
		try { value = ason.parse(raw) }
		catch (e) {
			if (!raw.endsWith('\n')) { tail = raw; break } // A torn last write stays for history.open().
			throw new Error(`${path}: malformed history: ${e}\n${raw}`)
		}
		try {
			let record = historyCheck.check(value)
			records.push({ ...record, n: record.n ?? offset + 1 })
		} catch (e) { throw new Error(`${path}: malformed history: ${e}\n${raw}`) }
		offset += Buffer.byteLength(raw)
	}
	let stripped = historyMigration.strip(records)
	if (ason.stringify(records) === ason.stringify(stripped)) return false
	// Invalidate byte-offset marks before replacing history. A crash at
	// either step rebuilds offsets. Retired numbers cannot be reused.
	let marks = liveFiles.liveFile<Record<string, unknown>>(path.replace(/history\.asonl$/, 'marks.ason'), {}, { watch: false })
	try {
		let next = marks.next
		if (next !== undefined && (!Number.isSafeInteger(next) || (next as number) < 1)) throw new Error(`${path}: invalid marks next`)
		for (let key of Object.keys(marks)) delete marks[key]
		Object.assign(marks, { size: 0, next: records.reduce((max, r) => Math.max(max, r.n! + 1), (next as number | undefined) ?? 1), inbox: {}, changes: [], changedPaths: {}, rebaseVersion: 1 })
		liveFiles.save(marks)
	} finally { liveFiles.close(marks) }
	let temp = `${path}.migrate`
	try {
		writeFileSync(temp, stripped.map((r) => lines.encode(r)).join('') + tail, { mode: statSync(path).mode & 0o777 })
		// The original stays beside it, so a stripping bug never loses history.
		if (!existsSync(`${path}.before-cs`)) linkSync(path, `${path}.before-cs`)
		renameSync(temp, path)
	} finally { rmSync(temp, { force: true }) }
	return true
}

function run(): void {
	let marker = liveFiles.liveFile<{ askRemoved: boolean }>(`${paths.stateDir()}/migrations.ason`, { askRemoved: false }, { watch: false, mode: 0o600 })
	try {
		if (typeof marker.askRemoved !== 'boolean') throw new Error(`${paths.stateDir()}/migrations.ason: invalid askRemoved`)
		if (marker.askRemoved) return
		// Search is a disposable projection; rewritten history can grow
		// when legacy byte-offset numbers become explicit.
		for (let suffix of ['', '-wal', '-shm']) rmSync(`${paths.stateDir()}/find.sqlite${suffix}`, { force: true })
		for (let entry of readdirSync(paths.sessionsDir(), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			let path = `${paths.sessionDir(entry.name)}/history.asonl`
			if (existsSync(path)) historyMigration.migrate(path)
		}
		marker.askRemoved = true
		liveFiles.save(marker)
	} finally { liveFiles.close(marker) }
}

export const historyMigration = { strip, migrate, run }
