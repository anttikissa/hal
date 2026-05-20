import { models } from '../models.ts'
import { openaiUsage } from '../openai-usage.ts'
import { perf } from '../perf.ts'

function perfMs(prefix: string): string | null {
	const hit = perf.snapshot().findLast((mark) => mark.name.startsWith(prefix))
	return hit ? `${hit.ms.toFixed(1)}ms` : null
}

function formatHomePath(path: string): string {
	const home = process.env.HOME
	if (!home) return path
	if (path === home) return '~'
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

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

function quotaWindowText(minutes: number): string {
	if (minutes > 0 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`
	if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`
	return `${minutes}m`
}

function startupQuotaLine(model: string): string {
	if (models.providerName(model).toLowerCase() !== 'openai') return ''
	const window = openaiUsage.current()?.primary
	if (!window) return ''
	const left = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)))
	return `${left}% left on ${quotaWindowText(window.windowMinutes)} quota, resetting at ${openaiUsage.formatResetAt(window.resetAt)}.`
}

function startupModelLine(model: string): string {
	if (!model) return ''
	const display = models.displayModel(model) || model
	const provider = providerDisplayName(model)
	const subscription = models.providerName(model).toLowerCase() === 'openai' ? chatGptSubscriptionText(openaiUsage.current()?.planType) : ''
	return `Using ${display} via ${provider}${subscription ? ` ${subscription}` : ''}.`
}

function startupPerfText(opts: any): string {
	const ready = perfMs('Ready for input')
	const firstLine = opts.role === 'server' ? `Server started (pid ${opts.pid})${ready ? ` · ready ${ready}` : ''}` : `Joined server (pid ${opts.hostPid ?? '?'})${ready ? ` · ready ${ready}` : ''}`
	const details = [
		['replay', perfMs('Active tab replayed')],
		['first draw', perfMs('First draw done')],
		['blobs', perfMs('Active tab blobs loaded')],
		['all tabs', perfMs('All tabs loaded')],
	].filter(([, ms]) => !!ms).map(([label, ms]) => `${label} ${ms}`)
	return details.length > 0 ? `${firstLine}\n${details.join(' · ')}` : firstLine
}

function text(tab: any, opts: any): string {
	const model = tab.model || opts.fallbackModel || ''
	const lines = [`Tab opened in ${formatHomePath(tab.cwd || process.cwd())}.`]
	const modelLine = startupModelLine(model)
	if (modelLine) lines.push('', modelLine)
	const quotaLine = startupQuotaLine(model)
	if (quotaLine) lines.push('', quotaLine)
	if (opts.showPerf) lines.push('', startupPerfText(opts))
	return lines.join('\n')
}

export const startupSummary = { text }
