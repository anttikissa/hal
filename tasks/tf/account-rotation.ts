type RotationStrategy = 'next' | 'leastUsed'

interface RotationCandidate {
	_key?: string
}

interface QuotaWindow {
	durationMinutes: number
	usedPercent: number
}

const config = {
	strategy: 'leastUsed' as RotationStrategy,
}

const io = {
	currentKey: (_provider: string): string => '',
	usageWindows: (_provider: string, _key: string): QuotaWindow[] => [],
}

function longestWindowUsage(provider: string, candidate: RotationCandidate): number | undefined {
	if (!candidate._key) return
	let duration = -Infinity
	let usage = -Infinity
	for (const window of accountRotation.io.usageWindows(provider, candidate._key)) {
		if (!Number.isFinite(window.durationMinutes) || !Number.isFinite(window.usedPercent)) continue
		if (window.durationMinutes < duration) continue
		if (window.durationMinutes > duration) usage = -Infinity
		duration = window.durationMinutes
		usage = Math.max(usage, window.usedPercent)
	}
	return Number.isFinite(usage) ? usage : undefined
}

function pick<T extends RotationCandidate>(provider: string, candidates: T[]): T | undefined {
	const next = candidates[0]
	if (!next || candidates.length === 1 || accountRotation.config.strategy !== 'leastUsed') return next
	const currentKey = accountRotation.io.currentKey(provider)
	for (const candidate of candidates) {
		if (candidate._key === currentKey) return candidate
	}

	// TODO: Add a "smart" strategy that considers reset deadlines, every active
	// quota, the requested model, plan capacity, and observation freshness. For
	// example, OpenAI account A may be at 61%/7d and reset in 20 minutes, B at
	// 24%/7d and reset in six days, while C is only 10%/7d but its 5h quota is
	// already 99%. leastUsed chooses C from the weekly figures, but smart might
	// spend A's soon-expiring capacity or avoid C's imminent short-window limit.
	// On Anthropic, account A could be 20% general/7d but 95% Sonnet/7d, while B
	// is 45% general/7d and 30% Sonnet/7d: smart should pick A for Opus and B for
	// Sonnet. API-key providers add monetary cost and no comparable percentage,
	// so cross-provider routing would need an explicit cost/preference policy.
	let best = next
	let bestUsage = Infinity
	for (const candidate of candidates) {
		const usage = accountRotation.longestWindowUsage(provider, candidate)
		if (usage == null) return next
		if (usage < bestUsage) {
			best = candidate
			bestUsage = usage
		}
	}
	return best
}

export const accountRotation = { config, io, longestWindowUsage, pick }
export type { QuotaWindow, RotationCandidate, RotationStrategy }
