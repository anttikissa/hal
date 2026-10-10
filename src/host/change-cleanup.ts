import { closeSync, existsSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { changedFiles } from './changed-files.ts'
import { fileTracking } from './file-tracking.ts'
import { historyCheck } from './history-check.ts'
import { liveFiles } from './live-file.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'

type Result = { records: number; removed: number; before: number; after: number; backup?: string }

async function* records(path: string): AsyncGenerator<{ record: HistoryRecord; offset: number; end: number }> {
	let decoder = new TextDecoder('utf-8', { fatal: true }), parts: string[] = [], offset = 0
	let parse = (text: string, bytes: number) => {
		let at = offset
		offset += bytes
		if (!text.trim()) return undefined
		try {
			let record = historyCheck.check(ason.parse(text))
			record.n ??= at + 1
			if (record.type === 'file_changes' && (typeof record.cwd !== 'string' || !Array.isArray(record.files) || record.files.some((f) => !f || typeof f.path !== 'string'))) throw new Error('invalid file_changes')
			return { record, offset: at, end: offset }
		} catch (e: any) { throw new Error(`${path}: malformed history at byte ${at}: ${e?.message ?? e}`) }
	}
	for await (let chunk of Bun.file(path).stream()) {
		let text = decoder.decode(chunk, { stream: true }), from = 0, at: number
		while ((at = text.indexOf('\n', from)) >= 0) {
			parts.push(text.slice(from, at))
			let line = parts.join('')
			parts = []
			from = at + 1
			let item = parse(line, Buffer.byteLength(line) + 1)
			if (item) yield item
		}
		if (from < text.length) parts.push(text.slice(from))
	}
	parts.push(decoder.decode())
	let tail = parts.join('')
	if (tail) {
		let item = parse(tail, Buffer.byteLength(tail))
		if (item) yield item
	}
}

async function digest(path: string): Promise<string> {
	let hash = createHash('sha256')
	for await (let chunk of Bun.file(path).stream()) hash.update(chunk)
	return hash.digest('hex')
}

async function backup(source: string, target: string): Promise<void> {
	let fd = openSync(target, 'wx', 0o600)
	try {
		for await (let chunk of Bun.file(source).stream()) writeFileSync(fd, chunk)
		fsyncSync(fd)
	} finally { closeSync(fd) }
}

function sync(path: string): void {
	let fd = openSync(path, 'r')
	try { fsyncSync(fd) } finally { closeSync(fd) }
}

async function filter(record: HistoryRecord): Promise<number> {
	if (record.type !== 'file_changes') return 0
	let kept: typeof record.files = [], removed = 0
	for (let at = 0; at < record.files.length; at += changeCleanup.batchSize) {
		let batch = record.files.slice(at, at + changeCleanup.batchSize)
		let allowed = new Set(await fileTracking.filter(record.cwd, batch.map((f) => f.path)))
		for (let file of batch) if (allowed.has(file.path)) kept.push(file); else removed++
	}
	record.files = kept
	return removed
}

async function validate(path: string, expected: string, count: number) {
	let hash = createHash('sha256'), n = 0
	let marks: Parameters<typeof pages.apply>[0] = { size: 0, inbox: {}, rebaseVersion: 1 }
	changedFiles.reset(marks)
	for await (let item of changeCleanup.records(path)) {
		hash.update(lines.encode(item.record))
		pages.apply(marks, item.record, item.offset, path)
		marks.size = item.end
		n++
	}
	if (hash.digest('hex') !== expected || n !== count) throw new Error(`${path}: cleanup validation failed`)
	marks.size = statSync(path).size
	return marks
}

// `live`: run inside the host holding the home lock; called synchronously
// just before replacement so the host drops caches of the old file.
async function run(id: string, apply = false, live?: () => void): Promise<Result> {
	let path = `${paths.sessionDir(id)}/history.asonl`
	if (live ? server.state.lockFd === null : server.state.lockFd !== null || !server.tryLock()) throw new Error(live ? 'live cleanup must run inside the host' : `${server.lockPath()}: host is running; use /changes cleanup in Hal instead`)
	let fd = server.state.lockFd!
	let token = randomUUID(), temp = `${path}.cleanup-${token}`, marksTemp = `${pages.marksPath(id)}.cleanup-${token}`
	let backup: string | undefined, backupReady = false
	try {
		let original = lstatSync(path)
		if (!original.isFile()) throw new Error(`${path}: cleanup requires a regular, non-symlink history file`)
		let originalDigest = await changeCleanup.digest(path)
		let result: Result = { records: 0, removed: 0, before: original.size, after: 0 }
		let hash = createHash('sha256'), out: number | undefined
		if (apply) out = openSync(temp, 'wx', 0o600)
		try {
			for await (let { record } of changeCleanup.records(path)) {
				result.removed += await changeCleanup.filter(record)
				let line = lines.encode(record)
				hash.update(line)
				if (out !== undefined) writeFileSync(out, line)
				result.after += Buffer.byteLength(line)
				result.records++
			}
			if (out !== undefined) fsyncSync(out)
		} finally { if (out !== undefined) closeSync(out) }
		if (!result.removed) return { ...result, after: result.before }
		if (!apply) return result
		let marks = await changeCleanup.validate(temp, hash.digest('hex'), result.records)
		let data = liveFiles.liveFile(marksTemp, { size: -1, inbox: {} }, { watch: false, mode: 0o600 })
		Object.assign(data, marks)
		liveFiles.save(data)
		liveFiles.close(data)
		changeCleanup.sync(marksTemp)
		backup = `${path}.before-cleanup-${token}`
		await changeCleanup.backup(path, backup)
		changeCleanup.sync(paths.sessionDir(id))
		backupReady = true
		let latest = lstatSync(path)
		if (!latest.isFile() || latest.ino !== original.ino || latest.size !== original.size || latest.mtimeMs !== original.mtimeMs || await changeCleanup.digest(backup) !== originalDigest || await changeCleanup.digest(path) !== originalDigest) throw new Error(`${path}: history changed during cleanup; original was not replaced`)
		let final = lstatSync(path)
		if (final.size !== original.size || final.mtimeMs !== original.mtimeMs) throw new Error(`${path}: history changed during cleanup; original was not replaced`)
		live?.()
		rmSync(pages.marksPath(id), { force: true })
		changeCleanup.sync(paths.sessionDir(id))
		renameSync(temp, path)
		changeCleanup.sync(paths.sessionDir(id))
		renameSync(marksTemp, pages.marksPath(id))
		changeCleanup.sync(paths.sessionDir(id))
		return { ...result, backup }
	} catch (e: any) {
		throw new Error(`${e?.message ?? e}${backup && existsSync(backup) ? `\n${backupReady ? 'Recoverable original' : 'Incomplete backup; original history was not replaced'}: ${backup}` : ''}`)
	} finally {
		try {
			rmSync(temp, { force: true })
			rmSync(marksTemp, { force: true })
		} finally {
			if (!live) {
				closeSync(fd)
				server.state.lockFd = null
			}
		}
	}
}

async function main(args: string[]): Promise<void> {
	if (args.length === 1 && args[0] === '--help') {
		console.log(`Usage: bun src/host/change-cleanup.ts [--apply] <session-id>\n\nPreview excluded file-change metadata by default; --apply approves replacement.\nHome: ${paths.home()}\nWith Hal running, use /changes cleanup [apply] <session-id> instead; never stop\nor suspend the host for this. Offline, the home lock excludes a running host.\nMemory is bounded by one history record, not the whole conversation.\nOnly excluded per-file audit metadata is removed. Cleanup preserves all\nconversation records and numbers, useful entries, and snapshot blobs.\nIt retains history.asonl.before-cleanup-<id>, validates before atomic replacement,\nand rebuilds byte-offset marks.\nTo recover: stop the host, copy the reported backup over history.asonl, remove\nthat session's marks.ason, then restart. No blob garbage collection is performed.`)
		return
	}
	let apply = args[0] === '--apply'
	if (apply) args = args.slice(1)
	if (args.length !== 1 || args[0]!.startsWith('-')) throw new Error('usage: bun src/host/change-cleanup.ts [--apply] <session-id>; see --help')
	let result = await changeCleanup.run(args[0]!, apply)
	console.log(`${apply ? 'Cleanup' : 'Preview'}: ${result.records} records preserved; ${result.removed} excluded entries; ${result.before} → ${result.after} bytes${result.backup ? `\nRecoverable original: ${result.backup}` : ''}`)
}

export const changeCleanup = { batchSize: 256, records, digest, backup, sync, filter, validate, run, main }

if (import.meta.main) await changeCleanup.main(process.argv.slice(2))
