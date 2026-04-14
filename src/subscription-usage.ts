// Shared helpers and config for OAuth subscription usage displays.

const config = {
	censorEmails: false,
}

function maskLabel(label: string, stars: number): string {
	if (!label) return ''
	return `${label[0]}${'*'.repeat(stars)}`
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

export const subscriptionUsage = { config, censorEmail }
