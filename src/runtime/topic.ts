import { resolveCompactModel, providerForModel, modelIdForModel } from '../config.ts'
import { getProvider } from '../provider.ts'

const GENERIC_TOPICS = new Set([
	'no response',
	'no response.',
	'greeting introduction',
	'greeting',
	'introduction',
	'initial greeting exchange',
])

function normalizeTopic(topic: string): string {
	return topic
		.trim()
		.toLowerCase()
		.replace(/[.!?,:;"'`]+/g, '')
		.replace(/\s+/g, ' ')
}

export function isGreetingText(text: string): boolean {
	const t = text.trim().toLowerCase()
	if (!t) return false
	if (t.length > 40) return false
	if (!/^[a-z0-9\s!?.,'-]+$/.test(t)) return false
	return /^(hi|hello|hey|yo|sup|good\s+(morning|afternoon|evening))\b/.test(t)
}

export function shouldSkipAutoTopic(topic: string, firstUserText?: string): boolean {
	const normalized = normalizeTopic(topic)
	if (!normalized) return true
	if (GENERIC_TOPICS.has(normalized)) return true
	if (firstUserText && isGreetingText(firstUserText) && normalized.includes('greeting')) return true
	return false
}

export async function generateAutoTopic(input: {
	sessionModel: string
	ctx: string
	firstUserText?: string
}): Promise<string | null> {
	if (input.firstUserText && isGreetingText(input.firstUserText)) return null
	const compactModel = resolveCompactModel(input.sessionModel)
	const provider = getProvider(providerForModel(compactModel))
	await provider.refreshAuth()

	const banned = [...GENERIC_TOPICS]
		.map((t) => `- ${t}`)
		.join('\n')
	const system = `Generate a short topic (3-6 words) for this conversation based on what the user is actually doing.
Be specific and concrete.
Avoid generic topics and greetings.
Never output any of these:
${banned}
Reply with ONLY the topic, no quotes, no punctuation at the end.`

	const { text: topic, error } = await provider.complete({
		model: modelIdForModel(compactModel),
		system,
		userMessage: input.ctx,
		maxTokens: 30,
	})

	if (error || !topic?.trim()) return null
	const trimmed = topic.trim()
	if (shouldSkipAutoTopic(trimmed, input.firstUserText)) return null
	return trimmed
}