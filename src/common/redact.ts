// Masks credentials in diagnostic text. Pure, so host and client can
// both run anything they log through it.

const MASK = '[redacted]'

// Names whose values are secrets, in key: value, key=value, "key": "value"
// and header forms. "token" but not "tokens", so usage counts survive.
const secretKey = String.raw`[\w-]*(?:token(?!s)|secret|password|api[_-]?key|authorization|cookie)[\w-]*`

const patterns: [RegExp, string][] = [
	// key: 'value', "key": "value", key=value, Authorization: Bearer x
	[new RegExp(String.raw`(["']?${secretKey}["']?\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?(["']?)[^\s"',&}]+\2`, 'gi'), `$1$2${MASK}$2`],
	[/\b(Bearer|Basic)\s+[\w.~+/=-]+/g, `$1 ${MASK}`],
	// Provider key prefixes (Anthropic, OpenAI, GitHub, Slack) and JWTs.
	[/\bsk-[\w-]{16,}/g, MASK],
	[/\b(?:gh[pousr]|github_pat)_\w{20,}/g, MASK],
	[/\bxox[abprs]-[\w-]{10,}/g, MASK],
	[/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, MASK],
]

function redact(text: string): string {
	for (let [re, to] of patterns) text = text.replace(re, to)
	return text
}

export const redaction = { redact }
