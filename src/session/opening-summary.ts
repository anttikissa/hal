import { models } from '../models.ts'
import { openaiUsage } from '../openai-usage.ts'
import { time } from '../utils/time.ts'
import { paths } from '../utils/paths.ts'

function titleWords(text: string): string {
	return text.split(/[-_\s]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join(' ')
}

function providerDisplayName(model: string): string {
	const provider = models.providerName(model).toLowerCase()
	if (provider === 'openai') return 'OpenAI'
	if (provider === 'openrouter') return 'OpenRouter'
	return titleWords(provider)
}

function chatGptSubscriptionText(planType: string | undefined): string {
	if (!planType) return ''
	return `(ChatGPT ${titleWords(planType.toLowerCase().replace(/^chatgpt[-_\s]*/, ''))} subscription)`
}

function startupQuotaLine(model: string): string {
	if (models.providerName(model).toLowerCase() !== 'openai') return ''
	const window = openaiUsage.current()?.primary
	if (!window) return ''
	const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)))
	const resetAtMs = window.resetAt * 1000
	return `${used}% used on ${time.formatQuotaWindow(window.windowMinutes)} quota, resetting at ${openaiUsage.formatResetAt(window.resetAt)} (${time.formatFutureDistance(resetAtMs)}).`
}

function startupModelLine(model: string): string {
	if (!model) return ''
	const display = models.displayModel(model) || model
	const provider = providerDisplayName(model)
	const subscription = models.providerName(model).toLowerCase() === 'openai' ? chatGptSubscriptionText(openaiUsage.current()?.planType) : ''
	return `Using ${display} via ${provider}${subscription ? ` ${subscription}` : ''}.`
}

function text(tab: any): string {
	const model = tab.model || ''
	const lines = [
		`Session \`${tab.sessionId}\` opened in ${paths.formatHomePath(tab.cwd || process.cwd())}; writing history to ${paths.historyDisplayPath(tab.sessionId, tab.currentLog)}`,
	]
	const modelLine = startupModelLine(model)
	if (modelLine) lines.push('', modelLine)
	const quotaLine = startupQuotaLine(model)
	if (quotaLine) lines.push('', quotaLine)
	lines.push('', 'Type `/help` for commands, `/keys` for keyboard shortcuts.')
	return lines.join('\n')
}

export const openingSummary = { text }
