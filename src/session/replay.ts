// Replay — rebuild session state from history for display and token counting.
//
// On startup (or tab switch), we replay history entries to reconstruct:
// 1. Display blocks for the TUI (via replayToBlocks)
// 2. Token usage estimates per session
// 3. Interrupted tool detection
//
// The previous codebase had a separate worker file for background hydration.
// Simplified here: everything runs in the main thread since history files are
// typically small (<1MB) and ason parsing is fast.

import type { HistoryEntry } from '../server/sessions.ts'
import { sessions } from '../server/sessions.ts'
import { blob } from './blob.ts'
import { models } from '../models.ts'

// ── Types ──

export interface ReplayBlock {
	type: 'input' | 'assistant' | 'thinking' | 'tool' | 'info' | 'error'
	text: string
	// Tool-specific fields
	name?: string
	args?: string
	output?: string
	status?: 'done' | 'error' | 'running'
	// Metadata
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

// ── Block conversion helpers ──

// Extract text from a user message's content field, which may be a string
// or an array of content blocks (text + image references).
function userContentText(content: any): string {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	return content
		.map((part: any) => {
			if (part?.type === 'text') return part.text ?? ''
			if (part?.type === 'image') {
				const file = part.originalFile ?? part.blobId ?? ''
				return file ? `[image ${file}]` : '[image]'
			}
			return ''
		})
		.join('')
}

// Extract tool output from blob data. Returns the output text and status.
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

// ── Core replay ──

// Replay a session's full history into display blocks. Loads blobs for tool
// calls to get their input/output. Returns blocks + token estimate.
function replaySession(sessionId: string, opts?: { model?: string }): ReplayResult {
	const entries = sessions.loadAllHistory(sessionId)
	return replayEntries(sessionId, entries, opts)
}

// Replay a pre-loaded array of history entries into blocks.
function replayEntries(sessionId: string, entries: HistoryEntry[], opts?: { model?: string }): ReplayResult {
	const model = opts?.model
	const blocks: ReplayBlock[] = []
	let tokenText = '' // accumulate text for rough token estimation

	// Build a set of tool_use_ids that have results, to find the result blobId
	const toolResultBlobs = new Map<string, string>()
	for (const m of entries) {
		if (m.role === 'tool_result' && m.tool_use_id && m.blobId) {
			toolResultBlobs.set(m.tool_use_id, m.blobId)
		}
	}

	for (const entry of entries) {
		const ts = entry.ts ? Date.parse(entry.ts) : undefined

		// Skip structural entries that don't produce blocks
		if (entry.type === 'reset' || entry.type === 'forked_from' || entry.type === 'compact') continue

		// Session events (model changes, init)
		if (entry.type === 'session') continue

		// Info/error entries
		if (entry.type === 'info') {
			if ((entry as any).level === 'error') {
				blocks.push({ type: 'error', text: entry.text ?? '', ts })
			} else {
				blocks.push({ type: 'info', text: entry.text ?? '', ts })
			}
			continue
		}

		// User messages
		if (entry.role === 'user') {
			const text = userContentText(entry.content)
			if (text) {
				blocks.push({
					type: 'input',
					text,
					model,
					source: typeof entry.source === 'string' ? entry.source : undefined,
					ts,
				})
				tokenText += text + '\n'
			}
			continue
		}

		// Assistant messages (may include thinking, text, and tool calls)
		if (entry.role === 'assistant') {
			// Thinking block
			if (entry.thinkingText) {
				blocks.push({
					type: 'thinking',
					text: entry.thinkingText,
					model,
					sessionId,
					blobId: entry.thinkingBlobId,
					ts,
				})
			}

			// Text response
			if (entry.text) {
				blocks.push({ type: 'assistant', text: entry.text, model, ts })
				tokenText += entry.text + '\n'
			}

			// Tool calls — load blob data for each to get input/output
			if (Array.isArray(entry.tools)) {
				for (const tool of entry.tools) {
					// Use the tool_result's blobId if available, else the tool call's blobId
					const resultBlobId = toolResultBlobs.get(tool.id)
					const blobId = resultBlobId ?? tool.blobId
					const blobData = blob.readBlobFromChain(sessionId, blobId)
					const { output, status, input } = extractToolOutput(blobData)

					blocks.push({
						type: 'tool',
						text: '', // tools use name/args/output instead
						name: tool.name,
						args: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
						output,
						status: blobData ? status : 'done',
						blobId,
						sessionId,
						ts,
					})
					tokenText += output + '\n'
				}
			}
			continue
		}

		// tool_result entries are handled via blob loading in assistant blocks above
	}

	// Detect interrupted tools (last assistant message has unmatched tool calls)
	const interrupted = sessions.detectInterruptedTools(entries)

	// Add interrupted hint
	if (interrupted.length > 0) {
		const toolList = interrupted.map((t) => t.name).join(', ')
		blocks.push({ type: 'info', text: `[interrupted] during tools (${toolList}). Press Enter to continue` })
	}

	return {
		blocks,
		tokenEstimate: models.estimateTokens(tokenText),
		model,
		interrupted,
	}
}

// ── Compaction context ──

// Build a summary of user prompts for context compaction. When a conversation
// is compacted to save tokens, this summary helps the model understand what
// was discussed.
function buildCompactionContext(sessionId: string, entries: HistoryEntry[]): string {
	const userPrompts: string[] = []
	for (const entry of entries) {
		if (entry.role !== 'user') continue
		const text = typeof entry.content === 'string' ? entry.content : ''
		if (!text || text.startsWith('[')) continue
		// First line, capped at 200 chars
		userPrompts.push(text.split('\n')[0].slice(0, 200))
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
		// Show first 10 and last 10 for long conversations
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

// ── Input history extraction ──

// Extract user input strings from history for readline-style input history.
function inputHistoryFromEntries(entries: HistoryEntry[]): string[] {
	return entries
		.filter((e) => e.role === 'user')
		.map((e) => {
			if (typeof e.content === 'string') return e.content
			if (Array.isArray(e.content)) {
				return e.content
					.filter((b: any) => b.type === 'text')
					.map((b: any) => b.text)
					.join(' ')
			}
			return ''
		})
		.filter((text) => text && !text.startsWith('['))
		.slice(-200) // cap at last 200 entries
}

export const replay = {
	replaySession,
	replayEntries,
	buildCompactionContext,
	inputHistoryFromEntries,
	extractToolOutput,
}
