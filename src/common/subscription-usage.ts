// Shared subscription-usage presentation contract. Servers emit semantic bar
// markers; each client decides how to render them for its own UI.

const BAR_MARKER = /\uE100hal-usage:(\d+):(\d+)\uE101/g

const config = {
	censorEmails: false,
}

function usageBarMarker(usedPercent: number, configuredWidth: number): string {
	const width = Math.max(1, Math.round(configuredWidth))
	const clamped = Math.max(0, Math.min(100, usedPercent))
	const totalEighths = Math.round((clamped / 100) * width * 8)
	return `\uE100hal-usage:${totalEighths}:${width}\uE101`
}

function replaceUsageBarMarkers(text: string, render: (totalEighths: number, width: number) => string): string {
	return text.replace(BAR_MARKER, (_marker, eighths, width) => render(Number(eighths), Number(width)))
}

function maskLabel(label: string, stars: number): string {
	if (!label) return ''
	// Status output goes through the markdown table renderer, so the masking stars
	// must be escaped to stay literal instead of turning nearby text italic.
	return `${label[0]}${'\\*'.repeat(stars)}`
}

function censorEmail(email: string): string {
	const at = email.indexOf('@')
	if (at === -1) return email
	const local = email.slice(0, at)
	const domain = email.slice(at + 1)
	const dot = domain.indexOf('.')
	if (dot === -1) return email
	const domainLabel = domain.slice(0, dot)
	const suffix = domain.slice(dot + 1)
	const maskedDomain = maskLabel(domainLabel, domainLabel.length <= 5 ? 4 : 3)
	return `${maskLabel(local, 3)}@${maskedDomain}.${suffix}`
}

export const subscriptionUsage = { config, usageBarMarker, replaceUsageBarMarkers, censorEmail }
