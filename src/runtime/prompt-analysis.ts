// Prompt analysis — fires a fast model call to classify user prompts.
// Returns mood, hal-modification intent, topic, etc.

import { loader } from '../providers/loader.ts'
import { models } from '../models.ts'

export interface PromptAnalysis {
	mood: string
	isHalChange: boolean
	needsContext: boolean
	topic: string
	durationMs: number
}

const ANALYSIS_PROMPT = `You are a prompt classifier. Analyze the user's message and return JSON only.

Fields:
- mood: one of "neutral", "frustrated", "happy", "curious", "urgent", "playful"
- isHalChange: true if the user wants to modify Hal itself (the AI assistant's code, config, behavior, system prompt, TUI, etc). false for general coding tasks.
- needsContext: true if the change seems to require conversation context (e.g. "do that thing we discussed"), false if it's a fresh standalone request
- topic: 2-5 word summary of what the message is about

Return ONLY valid JSON, no markdown fences.`

export async function analyzePrompt(text: string): Promise<PromptAnalysis | null> {
	const fastModel = models.resolveFastModel()
	if (!fastModel) return null

	const [providerName, modelId] = fastModel.split('/', 2)
	const start = performance.now()

	try {
		const provider = await loader.loadProvider(providerName)
		const gen = provider.generate({
			messages: [{ role: 'user', content: text }],
			model: modelId,
			systemPrompt: ANALYSIS_PROMPT,
		})

		let response = ''
		for await (const event of gen) {
			if (event.type === 'text') response += event.text
			if (event.type === 'error') return null
		}

		const durationMs = Math.round(performance.now() - start)
		const parsed = JSON.parse(response.trim())
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

export function formatAnalysis(text: string, analysis: PromptAnalysis): string {
	const preview = text.length > 24 ? text.slice(0, 24) + '…' : text
	const hal = analysis.isHalChange ? ` hal-change(ctx=${analysis.needsContext})` : ''
	return `[analysis] "${preview}" → ${analysis.mood}${hal} topic="${analysis.topic}" ${analysis.durationMs}ms`
}

export const promptAnalysis = { analyzePrompt, formatAnalysis }
