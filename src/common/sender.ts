// Host-established sender metadata shared by history and protocol validation.
function invalid(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'sender must be an object'
	let s = value as Record<string, unknown>
	for (let k of ['from', 'label', 'summary']) if (s[k] !== undefined && typeof s[k] !== 'string') return `invalid sender ${k}`
	if (s.report !== undefined && s.report !== 'question' && s.report !== 'summary') return 'invalid sender report'
	if (s.origin !== undefined && s.origin !== 'model') return 'invalid sender origin'
	if (s.generatingCommand !== undefined && s.generatingCommand !== 'clear') return 'invalid generating command'
	for (let k of ['advisory', 'steering', 'interject']) if (s[k] !== undefined && s[k] !== true) return `invalid sender ${k}`
}

export const sender = { invalid }
