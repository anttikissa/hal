// One-shot flat-history rollover.
//
// This script rewrites on-disk session logs from the old mixed history format
// (`role: 'assistant'`, embedded `thinkingBlobId`, embedded `tools`, ...)
// into the flat visible-event format used by the runtime now.
//
// It is intentionally a script, not runtime compatibility code.

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ason } from '../src/utils/ason.ts'

export interface FileMigrationResult {
	path: string
	changed: boolean
	backupPath?: string
	entriesBefore: number
	entriesAfter: number
}

export interface SessionMigrationResult {
	sessionId: string
	files: FileMigrationResult[]
}

export interface RolloverResult {
	rootDir: string
	stamp: string
	sessions: number
	files: number
	changedFiles: number
	entriesBefore: number
	entriesAfter: number
	results: SessionMigrationResult[]
}

function clean<T extends Record<string, any>>(obj: T): T {
	for (const key of Object.keys(obj)) {
		if (obj[key] === undefined) delete obj[key]
	}
	return obj
}

function normalizeUserParts(content: any): Array<{ type: 'text'; text: string } | { type: 'image'; blobId: string; originalFile?: string }> {
	if (Array.isArray(content)) {
		const parts: Array<{ type: 'text'; text: string } | { type: 'image'; blobId: string; originalFile?: string }> = []
		for (const part of content) {
			if (typeof part === 'string') {
				parts.push({ type: 'text', text: part })
				continue
			}
			if (part?.type === 'text' && typeof part.text === 'string') {
				parts.push({ type: 'text', text: part.text })
				continue
			}
			if (part?.type === 'image' && typeof part.blobId === 'string') {
				parts.push(clean({ type: 'image', blobId: part.blobId, originalFile: part.originalFile }))
			}
		}
		return parts
	}
	if (typeof content === 'string') return [{ type: 'text', text: content }]
	return []
}

function migrateFlatEntry(entry: any): any[] {
	switch (entry.type) {
		case 'user':
			return [clean({
				type: 'user',
				parts: normalizeUserParts(entry.parts ?? entry.content),
				source: entry.source,
				status: entry.status,
				ts: entry.ts,
			})]

		case 'thinking':
			return [clean({
				type: 'thinking',
				blobId: entry.blobId,
				provider: entry.provider,
				responseId: entry.responseId,
				ts: entry.ts,
			})]

		case 'assistant':
			if (typeof entry.text !== 'string' || entry.text.length === 0) return []
			return [clean({
				type: 'assistant',
				text: entry.text,
				model: entry.model,
				responseId: entry.responseId,
				continuation: entry.continuation,
				usage: entry.usage,
				ts: entry.ts,
			})]

		case 'tool_call':
			return [clean({
				type: 'tool_call',
				toolId: entry.toolId,
				name: entry.name,
				input: entry.input,
				blobId: entry.blobId,
				responseId: entry.responseId,
				ts: entry.ts,
			})]

		case 'tool_result':
			return [clean({
				type: 'tool_result',
				toolId: entry.toolId,
				output: entry.output,
				blobId: entry.blobId,
				isError: entry.isError,
				ts: entry.ts,
			})]

		case 'info':
			return [clean({ type: 'info', text: entry.text, level: entry.level, visibility: entry.visibility, ts: entry.ts })]

		case 'session':
			return [clean({ type: 'session', action: entry.action, model: entry.model, old: entry.old, new: entry.new, ts: entry.ts })]

		case 'reset':
		case 'compact':
			return [clean({ type: entry.type, ts: entry.ts })]

		case 'forked_from':
			return [clean({ type: 'forked_from', parent: entry.parent, ts: entry.ts })]

		case 'input_history':
			return [clean({ type: 'input_history', text: entry.text, ts: entry.ts })]

		default:
			throw new Error(`Unknown flat history entry type: ${entry.type}`)
	}
}

function migrateLegacyEntry(entry: any): any[] {
	if (entry.role === 'user') {
		return [clean({
			type: 'user',
			parts: normalizeUserParts(entry.content),
			source: entry.source,
			status: entry.status,
			ts: entry.ts,
		})]
	}

	if (entry.role === 'assistant') {
		const out: any[] = []
		if (entry.thinkingBlobId) out.push(clean({ type: 'thinking', blobId: entry.thinkingBlobId, ts: entry.ts }))
		if (typeof entry.text === 'string' && entry.text.length > 0) {
			out.push(clean({
				type: 'assistant',
				text: entry.text,
				model: entry.model,
				usage: entry.usage,
				ts: entry.ts,
			}))
		}
		if (Array.isArray(entry.tools)) {
			for (const tool of entry.tools) {
				out.push(clean({
					type: 'tool_call',
					toolId: tool.id,
					name: tool.name,
					input: tool.input,
					blobId: tool.blobId,
					ts: entry.ts,
				}))
			}
		}
		return out
	}

	if (entry.role === 'tool_result') {
		return [clean({
			type: 'tool_result',
			toolId: entry.tool_use_id,
			output: entry.output,
			blobId: entry.blobId,
			isError: entry.isError,
			ts: entry.ts,
		})]
	}

	throw new Error(`Unknown legacy history role: ${entry.role}`)
}

export function migrateHistoryEntries(entries: any[]): any[] {
	const out: any[] = []
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') throw new Error(`Invalid history entry: ${entry}`)
		if (typeof entry.type === 'string') out.push(...migrateFlatEntry(entry))
		else if (typeof entry.role === 'string') out.push(...migrateLegacyEntry(entry))
		else throw new Error(`History entry has neither type nor role: ${ason.stringify(entry, 'short')}`)
	}
	return out
}

function formatEntries(entries: any[]): string {
	if (entries.length === 0) return ''
	return entries.map((entry) => ason.stringify(entry, 'short')).join('\n') + '\n'
}

export function migrateHistoryFile(path: string, stamp = new Date().toISOString().slice(0, 10)): FileMigrationResult {
	const original = existsSync(path) ? readFileSync(path, 'utf-8') : ''
	const parsed = original.trim() ? (ason.parseAll(original) as any[]) : []
	const migrated = migrateHistoryEntries(parsed)
	const rewritten = formatEntries(migrated)
	if (rewritten === original) {
		return { path, changed: false, entriesBefore: parsed.length, entriesAfter: migrated.length }
	}

	const backupPath = `${path}.pre-flat-${stamp}`
	if (!existsSync(backupPath)) copyFileSync(path, backupPath)
	writeFileSync(path, rewritten)
	return { path, changed: true, backupPath, entriesBefore: parsed.length, entriesAfter: migrated.length }
}

export function migrateSessionDir(sessionDir: string, stamp = new Date().toISOString().slice(0, 10)): SessionMigrationResult {
	const files = readdirSync(sessionDir)
		.filter((name) => /^history\d*\.asonl$/.test(name))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		.map((name) => migrateHistoryFile(join(sessionDir, name), stamp))
	return { sessionId: sessionDir.split('/').pop() ?? sessionDir, files }
}

export function rolloverFlatHistory(rootDir: string, stamp = new Date().toISOString().slice(0, 10)): RolloverResult {
	const sessionDirs = readdirSync(rootDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(rootDir, entry.name))
		.sort()

	const results = sessionDirs.map((dir) => migrateSessionDir(dir, stamp))
	let files = 0
	let changedFiles = 0
	let entriesBefore = 0
	let entriesAfter = 0
	for (const session of results) {
		for (const file of session.files) {
			files++
			entriesBefore += file.entriesBefore
			entriesAfter += file.entriesAfter
			if (file.changed) changedFiles++
		}
	}

	return {
		rootDir,
		stamp,
		sessions: results.length,
		files,
		changedFiles,
		entriesBefore,
		entriesAfter,
		results,
	}
}

if (import.meta.main) {
	const rootDir = process.argv[2] ?? 'state/sessions'
	const stamp = process.argv[3] ?? new Date().toISOString().slice(0, 10)
	const result = rolloverFlatHistory(rootDir, stamp)
	console.log(ason.stringify({
		rootDir: result.rootDir,
		stamp: result.stamp,
		sessions: result.sessions,
		files: result.files,
		changedFiles: result.changedFiles,
		entriesBefore: result.entriesBefore,
		entriesAfter: result.entriesAfter,
	}, 'long'))
}
