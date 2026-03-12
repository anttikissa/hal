// Prompt analysis — fires a fast model call to classify user prompts.
// Uses a direct fetch to avoid the streaming provider overhead.

import { auth } from './auth.ts'
import { models } from '../models.ts'
import { history, type Message, type UserMessage, type AssistantMessage } from '../session/history.ts'

export interface PromptAnalysis {
	mood: string
	isHalChange: boolean
	needsContext: boolean
	topic: string
	durationMs: number
}

const ANALYSIS_PROMPT = `Classify this user prompt in context. The user's working directory is: {cwd}. Hal's own source code lives in ~/.hal. "isHalChange" means the user wants to modify Hal itself (not just use it). Return ONLY JSON: {"mood":"neutral|frustrated|happy|curious|urgent|playful","isHalChange":false,"needsContext":false,"topic":"2-5 words"}`

function extractRecentContext(entries: Message[], maxPairs: number): Array<{ role: string; content: string }> {
	const msgs: Array<{ role: string; content: string }> = []
	// Walk backwards to find the last N user/assistant pairs
	for (let i = entries.length - 1; i >= 0 && msgs.length < maxPairs * 2; i--) {
		const e = entries[i] as any
		if (e.role === 'user') {
			const text = typeof e.content === 'string' ? e.content
				: Array.isArray(e.content)
					? e.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') || '[image]'
					: '[unknown]'
			msgs.unshift({ role: 'user', content: text })
		} else if (e.role === 'assistant' && e.text) {
			// Skip thinking, just the reply text — truncate long responses
			const text = e.text.length > 200 ? e.text.slice(0, 200) + '…' : e.text
			msgs.unshift({ role: 'assistant', content: text })
		}
	}
	return msgs
}

async function analyzePrompt(text: string, sessionId?: string, cwd?: string): Promise<PromptAnalysis | null> {
	const fastModel = models.resolveFastModel()
	if (!fastModel) return null

	const [providerName, modelId] = fastModel.split('/', 2)
	if (providerName !== 'anthropic') return null

	const { accessToken } = auth.getAuth('anthropic')
	if (!accessToken) return null

	// Build context from recent history
	let contextMsgs: Array<{ role: string; content: string }> = []
	if (sessionId) {
		try {
			const entries = await history.readHistory(sessionId)
			contextMsgs = extractRecentContext(entries, 3)
		} catch {}
	}

	// Build the messages array: context + current prompt
	const messages = [
		...contextMsgs,
		{ role: 'user', content: `[ANALYZE THIS PROMPT]: ${text}` },
	]

	const start = performance.now()

	try {
		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': accessToken,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: modelId,
				max_tokens: 100,
				system: ANALYSIS_PROMPT.replace('{cwd}', cwd ?? 'unknown'),
				messages,
			}),
		})

		if (!res.ok) return null

		const data = await res.json() as any
		const raw = data.content?.[0]?.text ?? ''
		const json = raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim()
		const parsed = JSON.parse(json)
		const durationMs = Math.round(performance.now() - start)

		return {
			mood: parsed.mood ?? 'neutral',
			isHalChange: !!parsed.isHalChange,
			needsContext: !!parsed.needsContext,
			topic: parsed.topic ?? '',
			durationMs,
		}
	} catch {
		return null
	}
}

function formatAnalysis(text: string, analysis: PromptAnalysis): string {
	const preview = text.length > 24 ? text.slice(0, 24) + '…' : text
	const hal = analysis.isHalChange ? ` hal-change(ctx=${analysis.needsContext})` : ''
	return `[analysis] "${preview}" → ${analysis.mood}${hal} topic="${analysis.topic}" ${analysis.durationMs}ms`
}

export const promptAnalysis = { analyzePrompt, formatAnalysis, extractRecentContext }
