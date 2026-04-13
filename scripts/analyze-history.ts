// History cost probe: replay session prompts out of process and estimate
// what different pruning policies would cost with prompt caching.
//
// Usage:
// 	bun scripts/analyze-history.ts 04-whl
// 	bun scripts/analyze-history.ts --limit=20 --batch=4,8,16 --retry-rate=0.01

import type { Message, ContentBlock } from '../src/protocol.ts'
import { models } from '../src/models.ts'
import { sessions } from '../src/server/sessions.ts'
import { apiMessages } from '../src/session/api-messages.ts'

const READ_LIKE = new Set(['read', 'grep', 'glob', 'bash', 'read_url'])

interface Options {
	sessionId?: string
	limit: number
	batchSizes: number[]
	inputPrice: number
	cachedInputPrice: number
	heavyThreshold: number
	thinkingThreshold: number
	retryRate: number
	retryCostTokens: number
}

interface StrategySummary {
	requests: number
	promptTokens: number
	cachedTokens: number
	uncachedTokens: number
	costUsd: number
	prunedToolResults: number
	prunedReadResults: number
	retryPenaltyUsd: number
	totalWithRetryUsd: number
}

function parseArgs(argv: string[]): Options {
	const out: Options = {
		limit: 50,
		batchSizes: [4, 8, 16],
		inputPrice: 2.5,
		cachedInputPrice: 0.25,
		heavyThreshold: apiMessages.config.heavyThreshold,
		thinkingThreshold: apiMessages.config.thinkingThreshold,
		retryRate: 0.01,
		retryCostTokens: 12_000,
	}
	for (const arg of argv) {
		if (!arg.startsWith('--')) {
			out.sessionId = arg
			continue
		}
		const [key, value = ''] = arg.slice(2).split('=')
		if (key === 'limit') out.limit = Number(value) || out.limit
		if (key === 'batch') out.batchSizes = value.split(',').map(Number).filter((n) => n > 0)
		if (key === 'input-price') out.inputPrice = Number(value) || out.inputPrice
		if (key === 'cached-input-price') out.cachedInputPrice = Number(value) || out.cachedInputPrice
		if (key === 'heavy-threshold') out.heavyThreshold = Number(value) || out.heavyThreshold
		if (key === 'thinking-threshold') out.thinkingThreshold = Number(value) || out.thinkingThreshold
		if (key === 'retry-rate') out.retryRate = Number(value) || 0
		if (key === 'retry-cost') out.retryCostTokens = Number(value) || out.retryCostTokens
	}
	return out
}

function cloneMessages(msgs: Message[]): Message[] {
	return JSON.parse(JSON.stringify(msgs)) as Message[]
}

function isTurnEnd(msg: Message): boolean {
	if (msg.role !== 'assistant') return false
	if (!Array.isArray(msg.content)) return true
	return !(msg.content as ContentBlock[]).some((b) => b.type === 'tool_use')
}

function ages(msgs: Message[]): { age: number[]; completedTurns: number } {
	const age = new Array(msgs.length).fill(0)
	let completedTurns = 0
	for (let i = msgs.length - 1; i >= 0; i--) {
		age[i] = completedTurns
		if (isTurnEnd(msgs[i]!)) completedTurns++
	}
	return { age, completedTurns }
}

function pruneWithOffset(msgs: Message[], heavyThreshold: number, thinkingThreshold: number, offset: number): Message[] {
	const { age } = ages(msgs)
	return msgs.map((msg, i) => {
		const frozenAge = age[i]! - offset
		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			let content = (msg.content as ContentBlock[]).map((b) => b.type === 'tool_use' && frozenAge > heavyThreshold ? { ...b, input: {} } : b)
			if (frozenAge > thinkingThreshold) content = content.filter((b) => b.type !== 'thinking')
			return { ...msg, content }
		}
		if (msg.role === 'user' && Array.isArray(msg.content)) {
			const content = (msg.content as ContentBlock[]).map((b) => {
				if (b.type === 'tool_result' && frozenAge > heavyThreshold) return { ...b, content: '[tool result omitted from context]' }
				if (b.type === 'image' && frozenAge > heavyThreshold) return { type: 'text' as const, text: '[image omitted from context]' }
				return b
			})
			return { ...msg, content }
		}
		return msg
	})
}

function commonPrefixChars(a: string, b: string): number {
	const len = Math.min(a.length, b.length)
	let i = 0
	while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++
	return i
}

function countPrunedResults(msgs: Message[]): { prunedToolResults: number; prunedReadResults: number } {
	const toolNames = new Map<string, string>()
	for (const msg of msgs) {
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
		for (const block of msg.content as ContentBlock[]) {
			if (block.type === 'tool_use' && block.id && block.name) toolNames.set(block.id, block.name)
		}
	}
	let prunedToolResults = 0
	let prunedReadResults = 0
	for (const msg of msgs) {
		if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
		for (const block of msg.content as ContentBlock[]) {
			if (block.type !== 'tool_result' || block.content !== '[tool result omitted from context]') continue
			prunedToolResults++
			if (READ_LIKE.has(toolNames.get(block.tool_use_id ?? '') ?? '')) prunedReadResults++
		}
	}
	return { prunedToolResults, prunedReadResults }
}

function emptySummary(): StrategySummary {
	return { requests: 0, promptTokens: 0, cachedTokens: 0, uncachedTokens: 0, costUsd: 0, prunedToolResults: 0, prunedReadResults: 0, retryPenaltyUsd: 0, totalWithRetryUsd: 0 }
}

function roundSummary(summary: StrategySummary): StrategySummary {
	return {
		...summary,
		costUsd: Number(summary.costUsd.toFixed(6)),
		retryPenaltyUsd: Number(summary.retryPenaltyUsd.toFixed(6)),
		totalWithRetryUsd: Number(summary.totalWithRetryUsd.toFixed(6)),
	}
}

function analyzeSession(sessionId: string, opts: Options): Record<string, StrategySummary> {
	const entries = sessions.loadAllHistory(sessionId)
	const names = ['keep_all', 'rolling_prune', ...opts.batchSizes.map((n) => `batch_prune_${n}`)]
	const totals = Object.fromEntries(names.map((name) => [name, emptySummary()])) as Record<string, StrategySummary>
	const prevPrompts = Object.fromEntries(names.map((name) => [name, ''])) as Record<string, string>
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!
		if (entry.type !== 'user' && entry.type !== 'tool_result') continue
		const base = apiMessages.toProviderMessages(sessionId, entries.slice(0, i + 1), { prune: false })
		const variants: Record<string, Message[]> = {
			keep_all: base,
			rolling_prune: pruneWithOffset(cloneMessages(base), opts.heavyThreshold, opts.thinkingThreshold, 0),
		}
		const { completedTurns } = ages(base)
		for (const batchSize of opts.batchSizes) {
			const checkpoint = Math.floor(completedTurns / batchSize) * batchSize
			variants[`batch_prune_${batchSize}`] = pruneWithOffset(cloneMessages(base), opts.heavyThreshold, opts.thinkingThreshold, completedTurns - checkpoint)
		}
		for (const [name, msgs] of Object.entries(variants)) {
			const prompt = JSON.stringify(msgs)
			const promptTokens = models.estimateTokens(prompt)
			const prefixChars = commonPrefixChars(prevPrompts[name]!, prompt)
			const prefixTokens = models.estimateTokens(prompt.slice(0, prefixChars))
			const cachedTokens = promptTokens >= 1024 && prefixTokens >= 1024 ? Math.min(promptTokens, prefixTokens) : 0
			const uncachedTokens = promptTokens - cachedTokens
			const risk = countPrunedResults(msgs)
			const total = totals[name]!
			total.requests++
			total.promptTokens += promptTokens
			total.cachedTokens += cachedTokens
			total.uncachedTokens += uncachedTokens
			total.costUsd += (cachedTokens * opts.cachedInputPrice + uncachedTokens * opts.inputPrice) / 1_000_000
			total.prunedToolResults += risk.prunedToolResults
			total.prunedReadResults += risk.prunedReadResults
			prevPrompts[name] = prompt
		}
	}
	for (const total of Object.values(totals)) {
		total.retryPenaltyUsd = (total.prunedReadResults * opts.retryRate * opts.retryCostTokens * opts.inputPrice) / 1_000_000
		total.totalWithRetryUsd = total.costUsd + total.retryPenaltyUsd
	}
	return Object.fromEntries(Object.entries(totals).map(([name, summary]) => [name, roundSummary(summary)]))
}

function sessionIds(opts: Options): string[] {
	if (opts.sessionId) return [opts.sessionId]
	return sessions.loadAllSessionMetas()
		.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
		.slice(0, opts.limit)
		.map((meta) => meta.id)
}

function main(): void {
	const opts = parseArgs(process.argv.slice(2))
	const ids = sessionIds(opts)
	const perSession = [] as Array<{ sessionId: string; summary: Record<string, StrategySummary> }>
	for (const id of ids) perSession.push({ sessionId: id, summary: analyzeSession(id, opts) })
	perSession.sort((a, b) => (b.summary.rolling_prune?.totalWithRetryUsd ?? 0) - (b.summary.keep_all?.totalWithRetryUsd ?? 0) - ((a.summary.rolling_prune?.totalWithRetryUsd ?? 0) - (a.summary.keep_all?.totalWithRetryUsd ?? 0)))
	console.log(JSON.stringify({ config: opts, sessionsAnalyzed: perSession.length, perSession }, null, 2))
}

main()
