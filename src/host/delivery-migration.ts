// Temporary delivery-format switch before any host session read, under its lock.
// Each history is staged and validated before any is replaced. Atomic renames,
// original hard-link backups and a completion marker make crashes resumable.
// Remove this module and startup hook by 2026-10-10. Tasks: rqq.
import { createReadStream, existsSync, closeSync, fsyncSync, linkSync, openSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { historyCheck } from './history-check.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

type OldSender = Record<string, unknown>
type Tier = 'now' | 'next-round' | 'after-turn'
type Staged = { path: string; temp: string; next: number; bytes: number }

function sender(s: OldSender, fallback?: Tier): void {
	for (let k of ['steering', 'interject', 'queue', 'queued']) if (s[k] !== undefined && s[k] !== true) throw new Error(`invalid legacy delivery ${k}`)
	let delivery = s.delivery ?? (s.queue || s.queued || s.queuedAt ? 'after-turn' : s.steering ? 'now' : s.interject || s.advisory ? 'next-round' : fallback)
	for (let k of ['steering', 'interject', 'queue', 'queued']) delete s[k]
	if (delivery !== undefined) s.delivery = delivery
}

function convert(value: unknown, pending: Map<string, OldSender>): HistoryRecord {
	let r = value as Record<string, any>
	if (!r || typeof r !== 'object') return historyCheck.check(r)
	if (r.type === 'inbox') {
		deliveryMigration.sender(r, 'now')
		if (r.withdrawn) pending.delete(r.id)
		else pending.set(r.id, { ...r })
	} else if (r.type === 'user') {
		let queued = r.queued === true
		if (r.queue !== undefined || (r.queued !== undefined && !queued)) throw new Error('invalid legacy user delivery')
		delete r.queued
		let i = 0
		for (let b of r.blocks) if (b.type === 'text') {
			let origin = pending.get(r.inbox?.[i++] ?? '')
			deliveryMigration.sender(b, origin?.delivery as Tier | undefined ?? (queued ? 'after-turn' : undefined))
		}
		for (let id of r.inbox ?? []) pending.delete(id)
	} else if (r.type === 'command') deliveryMigration.sender(r)
	else if (r.type === 'output' && r.transition?.sender) deliveryMigration.sender(r.transition.sender)
	return historyCheck.check(r)
}

// Keep only one incomplete line in memory, not the whole history. A torn
// final record is an error: conversion never invokes lossy history repair.
async function stage(path: string, write = true): Promise<Staged> {
	let temp = `${path}.delivery-next`, fd = write ? openSync(temp, 'w', statSync(path).mode & 0o777) : undefined
	let decoder = new TextDecoder('utf-8', { fatal: true })
	let pending = new Map<string, OldSender>(), pieces: Buffer[] = [], offset = 0, next = 1, bytes = 0
	let output = (raw: Buffer | string): void => {
		bytes += typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length
		if (fd !== undefined) writeFileSync(fd, raw)
	}
	let line = (raw: Buffer): void => {
		let text: string
		try { text = decoder.decode(raw) }
		catch (e) { throw new Error(`${path}: invalid UTF-8 at byte ${offset}: ${e}\n${raw.toString('hex')}`) }
		if (!text.trim()) { output(raw); offset += raw.length; return }
		try {
			let record = deliveryMigration.convert(ason.parse(text), pending)
			record.n ??= offset + 1
			next = Math.max(next, record.n + 1)
			output(lines.encode(record))
		} catch (e) { throw new Error(`${path}: malformed history at byte ${offset}: ${e}\n${text}`) }
		offset += raw.length
	}
	try {
		for await (let chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
			let buf = chunk as Buffer, at = 0, end: number
			while ((end = buf.indexOf(10, at)) >= 0) {
				pieces.push(buf.subarray(at, end + 1))
				line(pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces))
				pieces = []; at = end + 1
			}
			if (at < buf.length) pieces.push(buf.subarray(at))
		}
		if (pieces.length) line(pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces))
		if (fd !== undefined) fsyncSync(fd)
		return { path, temp, next, bytes }
	} catch (e) { if (write) rmSync(temp, { force: true }); throw new Error(`${path}: delivery staging failed: ${e}`) }
	finally { if (fd !== undefined) closeSync(fd) }
}

function backup(path: string): void {
	if (!existsSync(path) || existsSync(`${path}.before-rqq`)) return
	linkSync(path, `${path}.before-rqq`)
	let fd = openSync(path, 'r')
	try { fsyncSync(fd) } finally { closeSync(fd) }
	deliveryMigration.syncDir(dirname(path))
}

function syncDir(path: string): void {
	let fd = openSync(path, 'r')
	try { fsyncSync(fd) }
	catch (e) { throw new Error(`${path}: cannot sync delivery conversion: ${e}`) }
	finally { closeSync(fd) }
}

function install(s: Staged): void {
	let path = s.path.replace(/history\.asonl$/, 'marks.ason')
	deliveryMigration.backup(path)
	let marks = liveFiles.liveFile<Record<string, unknown>>(path, {}, { watch: false })
	try {
		let next = marks.next
		if (next !== undefined && (!Number.isSafeInteger(next) || (next as number) < 1)) throw new Error(`${path}: invalid next ${ason.stringify(next)}`)
		for (let key of Object.keys(marks)) delete marks[key]
		Object.assign(marks, { size: 0, next: Math.max(s.next, (next as number | undefined) ?? 1), inbox: {}, changes: [], files: 0, rebaseVersion: 1 })
		liveFiles.save(marks)
	} finally { liveFiles.close(marks) }
	// Clear byte offsets first: either old or new history can rebuild them.
	deliveryMigration.backup(s.path)
	renameSync(s.temp, s.path)
	deliveryMigration.syncDir(dirname(s.path))
}

// Backups are hard links: retained original bytes are already allocated.
// Preflight counts exact encoded stage bytes plus rounded metadata blocks.
function space(staged: Staged[]): void {
	let disks = new Map<number, { path: string; need: number; free: number; block: number }>()
	for (let s of [...staged, { path: `${paths.stateDir()}/delivery-format.ason`, bytes: 0 }]) {
		let dir = dirname(s.path), dev = statSync(dir).dev, disk = disks.get(dev)
		if (!disk) {
			let fs = statfsSync(dir)
			disk = { path: dir, need: 0, free: fs.bavail * fs.bsize, block: fs.bsize }
			disks.set(dev, disk)
		}
		disk.need += Math.ceil(s.bytes / disk.block) * disk.block + disk.block
	}
	for (let d of disks.values()) if (d.need > d.free) throw new Error(`${d.path}: delivery conversion needs ${d.need} free bytes; only ${d.free} available. Original histories and backups are untouched.`)
}

function installed(path: string): boolean {
	let backup = `${path}.before-rqq`
	if (!existsSync(backup)) return false
	let a = statSync(path), b = statSync(backup)
	return a.dev !== b.dev || a.ino !== b.ino
}

async function run(): Promise<void> {
	let path = `${paths.stateDir()}/delivery-format.ason`
	let marker = liveFiles.liveFile<{ converted: boolean }>(path, { converted: false }, { watch: false, mode: 0o600 })
	let staged: Staged[] = []
	try {
		if (typeof marker.converted !== 'boolean') throw new Error(`${path}: invalid converted`)
		if (marker.converted) return
		for (let entry of readdirSync(paths.sessionsDir(), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			let history = `${paths.sessionDir(entry.name)}/history.asonl`
			if (existsSync(history) && !deliveryMigration.installed(history)) staged.push(await deliveryMigration.stage(history, false))
		}
		deliveryMigration.space(staged)
		for (let s of staged) await deliveryMigration.stage(s.path)
		// Byte-indexed search is disposable; busy.ason contains only IDs.
		for (let suffix of ['', '-wal', '-shm']) rmSync(`${paths.stateDir()}/find.sqlite${suffix}`, { force: true })
		for (let s of staged) deliveryMigration.install(s)
		marker.converted = true
		liveFiles.save(marker)
	} finally {
		for (let s of staged) rmSync(s.temp, { force: true })
		liveFiles.close(marker)
	}
}

export const deliveryMigration = { sender, convert, stage, backup, syncDir, install, installed, space, run }
