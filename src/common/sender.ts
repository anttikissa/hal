// Who sent a message, as the host sets it. History and protocol
// validation share these checks.
// Tasks: rj, jf, rqq.
function invalid(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'sender must be an object'
	let s = value as Record<string, unknown>
	if (s.interactive !== undefined && typeof s.interactive !== 'boolean') return 'invalid sender interactive'
	if (s.delivery !== undefined && !['now', 'next-round', 'after-turn'].includes(s.delivery as string))
		return 'invalid sender delivery'
	for (let k of ['from', 'label', 'summary'])
		if (s[k] !== undefined && typeof s[k] !== 'string') return `invalid sender ${k}`
	if (s.report !== undefined && s.report !== 'question' && s.report !== 'summary') return 'invalid sender report'
	if (s.origin !== undefined && s.origin !== 'model') return 'invalid sender origin'
	if (s.generatingCommand !== undefined && s.generatingCommand !== 'clear') return 'invalid generating command'
	for (let k of ['advisory']) if (s[k] !== undefined && s[k] !== true) return `invalid sender ${k}`
}

export const sender = { invalid }
