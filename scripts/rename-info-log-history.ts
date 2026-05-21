#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../src/state.ts'
import { ason } from '../src/utils/ason.ts'

function convertHistoryEntry(entry: any): any {
	if (!entry || typeof entry !== 'object' || entry.type !== 'info') return entry
	const out = { ...entry }
	delete out.ui
	delete out.level
	if (entry.ui === 'notice') {
		out.type = 'info'
	} else if (entry.level === 'warning') {
		out.type = 'warning'
	} else if (entry.level === 'error') {
		out.type = 'error'
	} else {
		out.type = 'log'
	}
	return out
}

function convertLiveBlock(block: any): any {
	if (!block || typeof block !== 'object') return block
	if (block.type === 'startup') return { ...block, type: 'info' }
	if (block.type === 'info') return { ...block, type: 'log' }
	return block
}

function backup(path: string): void {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	copyFileSync(path, `${path}.bak-${stamp}`)
}

function rewriteAsonl(path: string): number {
	const text = readFileSync(path, 'utf-8')
	const hadFinalNewline = text.endsWith('\n')
	const lines = text.split('\n')
	if (hadFinalNewline) lines.pop()
	let changed = 0
	const out = lines.map((line) => {
		if (!line.trim()) return line
		const before = ason.parse(line) as any
		const after = convertHistoryEntry(before)
		if (ason.stringify(before, 'short') !== ason.stringify(after, 'short')) changed++
		return ason.stringify(after, 'short')
	})
	if (changed > 0) {
		backup(path)
		writeFileSync(path, out.join('\n') + (hadFinalNewline ? '\n' : ''))
	}
	return changed
}

function rewriteLive(path: string): number {
	const data = ason.parse(readFileSync(path, 'utf-8')) as any
	if (!Array.isArray(data?.blocks)) return 0
	let changed = 0
	data.blocks = data.blocks.map((block: any) => {
		const after = convertLiveBlock(block)
		if (ason.stringify(block, 'short') !== ason.stringify(after, 'short')) changed++
		return after
	})
	if (changed > 0) {
		backup(path)
		writeFileSync(path, ason.stringify(data, 'long') + '\n')
	}
	return changed
}

function main(): void {
	const sessionsDir = join(STATE_DIR, 'sessions')
	if (!existsSync(sessionsDir)) return
	let filesChanged = 0
	let entriesChanged = 0
	for (const sessionId of readdirSync(sessionsDir)) {
		const dir = join(sessionsDir, sessionId)
		for (const name of readdirSync(dir)) {
			const path = join(dir, name)
			let changed = 0
			if (/^history\d*\.asonl$/.test(name)) changed = rewriteAsonl(path)
			else if (name === 'live.ason') changed = rewriteLive(path)
			if (changed > 0) {
				filesChanged++
				entriesChanged += changed
				console.log(`${path}: ${changed}`)
			}
		}
	}
	console.log(`Converted ${entriesChanged} entries in ${filesChanged} files.`)
}

main()
