// Replay visible history entries into UI blocks and a rough token estimate.

import type { HistoryEntry } from '../server/sessions.ts'
import { sessions } from '../server/sessions.ts'
import { models } from '../models.ts'
import { sessionEntry } from './entry.ts'

export interface ReplayBlock {
	type: 'input' | 'assistant' | 'thinking' | 'tool' | 'info' | 'error'
	text: string
	name?: string
	args?: string
	output?: string
	status?: 'done' | 'error' | 'running'
	model?: string
	source?: string
	ts?: number
	blobId?: string
	sessionId?: string
}

export interface ReplayResult {
	blocks: ReplayBlock[]
	tokenEstimate: number
	model?: string
	interrupted: { name: string; id: string }[]
}

function extractToolOutput(blobData: any): { output: string; status: 'done' | 'error'; input: any } {
	const callData = blobData?.call ?? {}
	const raw = blobData?.result?.content ?? ''
	const output =
		typeof raw === 'string'
			? raw
			: Array.isArray(raw)
				? raw
						.filter((b: any) => b.type === 'text')
						.map((b: any) => b.text)
						.join('') || '[image]'
				: ''
	const status: 'done' | 'error' =
		blobData?.result?.status === 'error' ? 'error' : blobData?.result ? 'done' : 'error'
	return { output, status, input: callData.input }
}

function replaySession(sessionId: string, opts?: { model?: string }): ReplayResult {
	const entries = sessions.loadAllHistory(sessionId)
	return replayEntries(sessionId, entries, opts)
}

function replayEntries(sessionId: string, entries: HistoryEntry[], opts?: { model?: string }): ReplayResult {
	const model = opts?.model
	const blocks: ReplayBlock[] = []
	let tokenText = ''
	const toolBlocks = new Map<string, ReplayBlock>()

	for (const entry of entries) {
		const ts = entry.ts ? Date.parse(entry.ts) : undefined
		if (entry.type === 'reset' || entry.type === 'forked_from' || entry.type === 'compact') continue
		if (entry.type === 'input_history') continue

		if (entry.type === 'info') {
			blocks.push({ type: entry.level === 'error' ? 'error' : 'info', text: entry.text, ts })
			continue
		}

		if (entry.type === 'user') {
			const text = sessionEntry.userText(entry, { images: 'path-or-blob-or-image' })
			if (!text) continue
			blocks.push({ type: 'input', text, model, source: entry.source, ts })
			tokenText += text + '\n'
			continue
		}

		if (entry.type === 'thinking') {
			let text = entry.text ?? ''
			if (!text) {
				const blobData = sessionEntry.loadEntryBlob(sessionId, entry)
				text = blobData?.thinking ?? ''
			}
			blocks.push({ type: 'thinking', text, model, sessionId, blobId: entry.blobId, ts })
			continue
		}

		if (entry.type === 'assistant') {
			blocks.push({ type: 'assistant', text: entry.text, model, ts })
			tokenText += entry.text + '\n'
			continue
		}

		if (entry.type === 'tool_call') {
			let input = entry.input
			let output = ''
			let status: 'done' | 'error' | 'running' = 'running'
			const blobData = sessionEntry.loadEntryBlob(sessionId, entry)
			if (input === undefined) input = blobData?.call?.input
			if (blobData?.result) {
				const extracted = extractToolOutput(blobData)
				output = extracted.output
				status = extracted.status
				input = input ?? extracted.input
			}
			const block: ReplayBlock = {
				type: 'tool',
				text: '',
				name: entry.name,
				args: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
				output,
				status,
				blobId: entry.blobId,
				sessionId,
				ts,
			}
			blocks.push(block)
			toolBlocks.set(entry.toolId, block)
			if (output) tokenText += output + '\n'
			continue
		}

		if (entry.type === 'tool_result') {
			const block = toolBlocks.get(entry.toolId)
			let output = entry.output
			let status: 'done' | 'error' = entry.isError ? 'error' : 'done'
			if (output === undefined) {
				const blobData = sessionEntry.loadEntryBlob(sessionId, entry)
				const extracted = extractToolOutput(blobData)
				output = extracted.output
				status = extracted.status
			}
			if (block) {
				block.output = typeof output === 'string' ? output : JSON.stringify(output ?? '')
				block.status = status
				if (!block.blobId) block.blobId = entry.blobId
				if (block.output) tokenText += block.output + '\n'
			} else {
				const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
				blocks.push({ type: 'tool', text: '', output: text, status, blobId: entry.blobId, sessionId, ts })
				if (text) tokenText += text + '\n'
			}
		}
	}

	const interrupted = sessions.detectInterruptedTools(entries)
	if (interrupted.length > 0) {
		const toolList = interrupted.map((t) => t.name).join(', ')
		blocks.push({ type: 'info', text: `[interrupted] during tools (${toolList}). enter: continue` })
	}

	return {
		blocks,
		tokenEstimate: models.estimateTokens(tokenText),
		model,
		interrupted,
	}
}

function buildCompactionContext(sessionId: string, entries: HistoryEntry[]): string {
	const userPrompts: string[] = []
	for (const entry of entries) {
		if (entry.type !== 'user') continue
		const text = sessionEntry.userText(entry)
		if (!text || text.startsWith('[')) continue
		userPrompts.push(text.split('\n')[0]!.slice(0, 200))
	}

	const dir = sessions.sessionDir(sessionId)
	if (userPrompts.length === 0) {
		return `Context was compacted. No user prompts in previous conversation. Full history: ${dir}/history*.asonl + blobs/`
	}

	const lines: string[] = [
		'Context was compacted to avoid exceeding the token limit. Verify before assuming.',
		'',
		'User messages from previous conversation:',
		'',
	]

	if (userPrompts.length <= 20) {
		userPrompts.forEach((p, i) => lines.push(`${i + 1}. ${p}`))
	} else {
		lines.push('First 10:')
		userPrompts.slice(0, 10).forEach((p, i) => lines.push(`${i + 1}. ${p}`))
		lines.push('')
		lines.push('Last 10:')
		const start = userPrompts.length - 10
		userPrompts.slice(-10).forEach((p, i) => lines.push(`${start + i + 1}. ${p}`))
	}

	lines.push('')
	lines.push(`Full history: ${dir}/history*.asonl + blobs/`)
	return lines.join('\n')
}

function inputHistoryFromEntries(entries: HistoryEntry[]): string[] {
	return entries
		.map((entry) => {
			if (entry.type === 'input_history') return entry.text
			// Up-arrow recall is for things the human typed. Inbox / subagent handoffs
			// are persisted as user entries with a source session id, but they should
			// never show up in local editing history.
			if (entry.type !== 'user' || entry.source) return ''
			return sessionEntry.userText(entry, { separator: ' ' })
		})
		.filter((text) => text && !text.startsWith('['))
		.slice(-200)
}

export const replay = {
	replaySession,
	replayEntries,
	buildCompactionContext,
	inputHistoryFromEntries,
	extractToolOutput,
}
