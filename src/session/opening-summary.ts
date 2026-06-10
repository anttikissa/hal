import { anthropicUsage } from '../anthropic-usage.ts'
import { models } from '../models.ts'
import { openaiUsage } from '../openai-usage.ts'
import { time } from '../utils/time.ts'
import { paths } from '../utils/paths.ts'

function titleWords(text: string): string {
	return text.split(/[-_\s]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join(' ')
}

function providerDisplayName(provider: string): string {
	if (provider === 'openai') return 'OpenAI'
	if (provider === 'openrouter') return 'OpenRouter'
	return titleWords(provider)
}

function chatGptSubscriptionText(): string {
	const plan = openaiUsage.current()?.planType
	return plan ? ` (ChatGPT ${titleWords(plan.toLowerCase().replace(/^chatgpt[-_\s]*/, ''))} subscription)` : ''
}

function quotaLine(window: { usedPercent?: number; windowMinutes?: number; resetAt?: number } | undefined, resetAtIsSeconds = false): string {
	if (window?.usedPercent == null || !window.resetAt) return ''
	const resetAtMs = resetAtIsSeconds ? window.resetAt * 1000 : window.resetAt
	const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)))
	return `${used}% used on ${time.formatQuotaWindow(window.windowMinutes ?? 300)} quota, resetting at ${time.formatResetAt(resetAtMs)} (${time.formatFutureDistance(resetAtMs)}).`
}

function startupQuotaLine(provider: string): string {
	if (provider === 'openai') return quotaLine(openaiUsage.current()?.primary, true)
	if (provider === 'anthropic') return quotaLine(anthropicUsage.current()?.fiveHour)
	return ''
}

function text(tab: any): string {
	const model = tab.model || ''
	const provider = models.providerName(model).toLowerCase()
	const display = models.displayModel(model) || model
	const lines = [
		`Session \`${tab.sessionId}\` opened in ${paths.formatHomePath(tab.cwd || process.cwd())}; writing history to ${paths.historyDisplayPath(tab.sessionId, tab.currentLog)}`,
	]
	if (display) lines.push('', `Using ${display} via ${providerDisplayName(provider)}${provider === 'openai' ? chatGptSubscriptionText() : ''}.`)
	const usage = startupQuotaLine(provider)
	if (usage) lines.push('', usage)
	lines.push('', 'Type `/help` for commands, `/keys` for keyboard shortcuts.')
	return lines.join('\n')
}

export const openingSummary = { text }
