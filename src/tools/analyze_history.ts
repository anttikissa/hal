// Analyze history tool — estimate prompt-cache cost for different pruning policies.
//
// This helps compare full-history replay, rolling pruning, and batched pruning.

import type { Message, ContentBlock } from '../protocol.ts'
import { models } from '../models.ts'
import { sessions } from '../server/sessions.ts'
import { apiMessages } from '../session/api-messages.ts'
import { toolRegistry, type ToolContext } from './tool.ts'

const READ_LIKE = new Set(['read', 'grep', 'glob', 'bash', 'read_url'])

interface AnalyzeOptions {
	inputPrice: number
	cachedInputPrice: number
	heavyThreshold: number
	thinkingThreshold: number
	batchSizes: number[]
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

function defaults(input: any): AnalyzeOptions {
	return {
		inputPrice: Number(input?.inputPrice ?? 2.5),
		cachedInputPrice: Number(input?.cachedInputPrice ?? 0.25),
		heavyThreshold: Number(input?.heavyThreshold ?? apiMessages.config.heavyThreshold),
		thinkingThreshold: Number(input?.thinkingThreshold ?? apiMessages.config.thinkingThreshold),
		batchSizes: Array.isArray(input?.batchSizes) ? input.batchSizes.map(Number).filter((n: number) => n > 0) : [4, 8, 16],
		retryRate: Number(input?.retryRate ?? 0.01),
		retryCostTokens: Number(input?.retryCostTokens ?? 12_000),
	}
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
			let content = (msg.content as ContentBlock[]).map((b) => {
				if (b.type === 'tool_use' && frozenAge > heavyThreshold) return { ...b, input: {} }
				return b
			})
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

function summarizeSnapshots(snapshots: Message[][], opts: AnalyzeOptions, apply: (msgs: Message[]) => Message[]): StrategySummary {
	let prevPrompt = ''
	const summary: StrategySummary = {
		requests: 0,
		promptTokens: 0,
		cachedTokens: 0,
		uncachedTokens: 0,
		costUsd: 0,
		prunedToolResults: 0,
		prunedReadResults: 0,
		retryPenaltyUsd: 0,
		totalWithRetryUsd: 0,
	}
	for (const snapshot of snapshots) {
		const pruned = apply(cloneMessages(snapshot))
		const prompt = JSON.stringify(pruned)
		const promptTokens = models.estimateTokens(prompt)
		const prefixChars = commonPrefixChars(prevPrompt, prompt)
		const prefixTokens = models.estimateTokens(prompt.slice(0, prefixChars))
		const cachedTokens = promptTokens >= 1024 && prefixTokens >= 1024 ? Math.min(promptTokens, prefixTokens) : 0
		const uncachedTokens = promptTokens - cachedTokens
		const risk = countPrunedResults(pruned)
		summary.requests++
		summary.promptTokens += promptTokens
		summary.cachedTokens += cachedTokens
		summary.uncachedTokens += uncachedTokens
		summary.costUsd += (cachedTokens * opts.cachedInputPrice + uncachedTokens * opts.inputPrice) / 1_000_000
		summary.prunedToolResults += risk.prunedToolResults
		summary.prunedReadResults += risk.prunedReadResults
		prevPrompt = prompt
	}
	summary.retryPenaltyUsd = (summary.prunedReadResults * opts.retryRate * opts.retryCostTokens * opts.inputPrice) / 1_000_000
	summary.totalWithRetryUsd = summary.costUsd + summary.retryPenaltyUsd
	return summary
}

function analyzeSnapshots(snapshots: Message[][], rawOpts?: Partial<AnalyzeOptions>): Record<string, StrategySummary> {
	const opts = { ...defaults({}), ...rawOpts }
	const out: Record<string, StrategySummary> = {
		keep_all: summarizeSnapshots(snapshots, opts, (msgs) => msgs),
		rolling_prune: summarizeSnapshots(snapshots, opts, (msgs) => pruneWithOffset(msgs, opts.heavyThreshold, opts.thinkingThreshold, 0)),
	}
	for (const batchSize of opts.batchSizes) {
		out[`batch_prune_${batchSize}`] = summarizeSnapshots(snapshots, opts, (msgs) => {
			const { completedTurns } = ages(msgs)
			const checkpoint = Math.floor(completedTurns / batchSize) * batchSize
			return pruneWithOffset(msgs, opts.heavyThreshold, opts.thinkingThreshold, completedTurns - checkpoint)
		})
	}
	return out
}

function requestSnapshots(sessionId: string): Message[][] {
	const entries = sessions.loadAllHistory(sessionId)
	const out: Message[][] = []
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!
		if (entry.type !== 'user' && entry.type !== 'tool_result') continue
		out.push(apiMessages.toProviderMessages(sessionId, entries.slice(0, i + 1), { prune: false }))
	}
	return out
}

function roundSummary(summary: StrategySummary): StrategySummary {
	return {
		...summary,
		costUsd: Number(summary.costUsd.toFixed(6)),
		retryPenaltyUsd: Number(summary.retryPenaltyUsd.toFixed(6)),
		totalWithRetryUsd: Number(summary.totalWithRetryUsd.toFixed(6)),
	}
}

async function execute(input: any, _ctx: ToolContext): Promise<string> {
	const opts = defaults(input)
	const ids = typeof input?.sessionId === 'string'
		? [input.sessionId]
		: sessions
				.loadAllSessionMetas()
				.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
				.slice(0, Number(input?.limit ?? 50))
				.map((meta) => meta.id)
	const aggregate: Record<string, StrategySummary> = {}
	const perSession: any[] = []
	for (const id of ids) {
		const snapshots = requestSnapshots(id)
		if (snapshots.length === 0) continue
		const analysis = analyzeSnapshots(snapshots, opts)
		perSession.push({ sessionId: id, requests: snapshots.length, summary: Object.fromEntries(Object.entries(analysis).map(([k, v]) => [k, roundSummary(v)])) })
		for (const [name, summary] of Object.entries(analysis)) {
			const acc = aggregate[name] ?? {
				requests: 0,
				promptTokens: 0,
				cachedTokens: 0,
				uncachedTokens: 0,
				costUsd: 0,
				prunedToolResults: 0,
				prunedReadResults: 0,
				retryPenaltyUsd: 0,
				totalWithRetryUsd: 0,
			}
			for (const key of Object.keys(acc) as (keyof StrategySummary)[]) acc[key] += summary[key]
			aggregate[name] = acc
		}
	}
	perSession.sort((a, b) => (b.summary.rolling_prune.totalWithRetryUsd - b.summary.keep_all.totalWithRetryUsd) - (a.summary.rolling_prune.totalWithRetryUsd - a.summary.keep_all.totalWithRetryUsd))
	return JSON.stringify({
		config: opts,
		sessionsAnalyzed: perSession.length,
		aggregate: Object.fromEntries(Object.entries(aggregate).map(([k, v]) => [k, roundSummary(v)])),
		worstRollingPenaltySessions: perSession.slice(0, 10),
	}, null, 2)
}

const analyzeHistoryTool = {
	name: 'analyze_history',
	description: 'Analyze past sessions and estimate prompt-cache cost for different pruning strategies.',
	parameters: {
		sessionId: { type: 'string', description: 'Analyze one session ID instead of many recent sessions' },
		limit: { type: 'integer', description: 'How many recent sessions to analyze when sessionId is omitted (default: 50)' },
		batchSizes: { type: 'array', items: { type: 'integer' }, description: 'Batch-prune intervals in completed turns' },
		retryRate: { type: 'number', description: 'Heuristic probability that a pruned read-like result causes a retry later' },
		retryCostTokens: { type: 'integer', description: 'Heuristic uncached input tokens per retry incident' },
		inputPrice: { type: 'number', description: 'Uncached input price in USD per 1M tokens' },
		cachedInputPrice: { type: 'number', description: 'Cached input price in USD per 1M tokens' },
	},
	execute,
}

function init(): void {
	toolRegistry.registerTool(analyzeHistoryTool)
}

export const analyzeHistory = { analyzeSnapshots, execute, init }
