// Prompt analysis — fires a fast model call to classify user prompts.
// Uses a direct fetch to avoid the streaming provider overhead.

import { auth } from './auth.ts'
import { models } from '../models.ts'

export interface PromptAnalysis {
	mood: string
	isHalChange: boolean
	needsContext: boolean
	topic: string
	durationMs: number
}

const ANALYSIS_PROMPT = `Classify this prompt. Return ONLY JSON: {"mood":"neutral|frustrated|happy|curious|urgent|playful","isHalChange":false,"needsContext":false,"topic":"2-5 words"}`

async function analyzePrompt(text: string): Promise<PromptAnalysis | null> {
	const fastModel = models.resolveFastModel()
	if (!fastModel) return null

	const [providerName, modelId] = fastModel.split('/', 2)
	if (providerName !== 'anthropic') return null

	const { accessToken } = auth.getAuth('anthropic')
	if (!accessToken) return null

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
				system: ANALYSIS_PROMPT,
				messages: [{ role: 'user', content: text }],
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

export const promptAnalysis = { analyzePrompt, formatAnalysis }
