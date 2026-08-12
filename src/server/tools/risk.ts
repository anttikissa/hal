// Simple model-stupidity guardrails for risky tool calls.
// This is not a sandbox. It only asks the user before likely destructive or
// secret-exposing operations so accidental model mistakes are visible.

import { resolve } from 'path'

export type RiskSeverity = 'danger' | 'secret' | 'maybe-secret'
export interface RiskFinding { severity: RiskSeverity; reason: string }

const secretPatterns: Array<[RegExp, RiskSeverity, string]> = [
	[/auth\.ason\b/i, 'secret', 'auth.ason contains provider credentials'],
	[/(^|[\s'"=:])~?\/?\.ssh(\/|\b)/i, 'maybe-secret', '~/.ssh may expose private keys'],
	[/\.ssh\/(id_rsa|id_dsa|id_ecdsa|id_ed25519|[^\s'";|&]*\.pem)\b/i, 'secret', 'SSH private key likely contains secrets'],
	[/(^|[\/\s'"=:])\.npmrc\b/i, 'secret', '.npmrc often contains registry auth tokens'],
	[/(^|[\/\s'"=:])\.kube\/config\b/i, 'secret', 'kube config often contains tokens or client certs'],
	[/(^|[\/\s'"=:])\.docker\/config\.json\b/i, 'secret', 'Docker config may contain registry auth'],
	[/(^|[\/\s'"=:])\.config\/gh\/hosts\.yml\b/i, 'secret', 'GitHub hosts file often contains oauth_token'],
	[/(^|[\/\s'"=:])\.azure\/(msal_token_cache|accessTokens|servicePrincipalProfile|azureProfile)/i, 'secret', 'Azure CLI auth/cache file may contain cloud credentials'],
	[/(^|[\/\s'"=:])\.azure(\/|\b)/i, 'maybe-secret', '.azure may contain cloud credentials'],
	[/(^|[\/\s'"=:])\.env(\.|\b|\*)/i, 'secret', '.env files often contain secrets'],
	[/(^|[\/\s'"=:])\.zsh_history\b|(^|[\/\s'"=:])\.bash_history\b/i, 'maybe-secret', 'shell history might contain secrets'],
	[/(^|[\/\s'"=:])\.zshrc\b|(^|[\/\s'"=:])\.bashrc\b|(^|[\/\s'"=:])\.profile\b/i, 'maybe-secret', 'shell startup file might contain secrets'],
	[/\.(pem|p12|pfx|jks|agekey)\b/i, 'secret', 'private key/certificate file likely contains secrets'],
]

function add(out: RiskFinding[], severity: RiskSeverity, reason: string): void {
	if (!out.some((item) => item.reason === reason)) out.push({ severity, reason })
}

function textOf(value: unknown): string {
	if (value === undefined || value === null) return ''
	if (typeof value === 'string') return value
	try { return JSON.stringify(value) } catch { return String(value) }
}

function variableMap(command: string): Map<string, string> {
	const vars = new Map<string, string>()
	for (const match of command.matchAll(/(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=(?:(\/tmp\/[^\s;&|]+)|\$\(mktemp -d\))/g)) {
		vars.set(match[1]!, match[2] ?? '/tmp/.mktemp-child')
	}
	return vars
}

function cleanShellToken(token: string, vars: Map<string, string>): string {
	let out = token.trim().replace(/^['"]|['"]$/g, '')
	const varMatch = out.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
	if (varMatch && vars.has(varMatch[1]!)) out = vars.get(varMatch[1]!)!
	return out
}

function isSafeTmpRemoval(target: string): boolean {
	if (!target || target === '/tmp' || target === '/tmp/' || target === '/tmp/*') return false
	if (target.includes('..')) return false
	if (target.includes('*') && !target.startsWith('/tmp/')) return false
	return resolve('/', target).startsWith('/tmp/')
}

function rmRfIsOnlySafeTmp(command: string): boolean {
	const vars = variableMap(command)
	for (const segment of command.split(/[\n;&|]+/)) {
		const match = segment.match(/\brm\s+(.+)/i)
		if (!match) continue
		const tokens = match[1]!.trim().split(/\s+/)
		const opts = tokens.filter((token) => token.startsWith('-')).join('')
		if (!opts.includes('r') || !opts.includes('f')) continue
		const targets = tokens.filter((token) => !token.startsWith('-')).map((token) => cleanShellToken(token, vars))
		if (targets.length === 0) return false
		if (targets.some((target) => !isSafeTmpRemoval(target))) return false
	}
	return true
}

function checkText(text: string, out: RiskFinding[]): void {
	for (const [pattern, severity, reason] of secretPatterns) {
		if (pattern.test(text)) add(out, severity, reason)
	}
}

function checkShell(command: string, out: RiskFinding[]): void {
	checkText(command, out)
	const lower = command.toLowerCase()
	const hasRmRf = /\brm\s+[^\n;&|]*-[^\n;&|]*r[^\n;&|]*f|\brm\s+[^\n;&|]*-[^\n;&|]*f[^\n;&|]*r/.test(lower)
	if (hasRmRf && !rmRfIsOnlySafeTmp(command)) add(out, 'danger', 'DESTRUCTIVE RM -RF COMMAND')
	if (/\bgit\s+reset\s+--hard\b/i.test(command)) add(out, 'danger', 'DESTRUCTIVE GIT RESET --HARD')
	if (/\bgit\s+clean\b[^\n;&|]*-[^\n;&|]*[xfd]/i.test(command)) add(out, 'danger', 'DESTRUCTIVE GIT CLEAN')
	if (/\bgit\s+stash\s+(drop|clear)\b/i.test(command)) add(out, 'danger', 'DESTRUCTIVE GIT STASH DROP/CLEAR')
	if (/\bgit\s+push\b[^\n;&|]*(--force|-f\b)/i.test(command)) add(out, 'danger', 'DESTRUCTIVE GIT PUSH --FORCE')
	for (const match of command.matchAll(/\bgit\s+(checkout|restore)\b([^\n;&|]*)/gi)) {
		const args = match[2] ?? ''
		if (/--\s+\S/.test(args) || /\s(\.|\/|[^\s]+\.[A-Za-z0-9]+)\b/.test(args)) add(out, 'danger', 'DESTRUCTIVE GIT CHECKOUT/RESTORE PATH')
	}
}

function analyzeToolCall(name: string, input: unknown): RiskFinding[] {
	const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {}
	const out: RiskFinding[] = []
	if (name === 'eval') return out
	if (name === 'bash') checkShell(String(raw.command ?? ''), out)
	// For file tools, only inspect path/pattern — not file contents or edit bodies,
	// which routinely contain string literals like 'auth.ason' in tests/docs.
	// Bash is checked in full because it can read arbitrary files via shell.
	else if (['read', 'grep', 'glob', 'write', 'edit'].includes(name)) {
		checkText(textOf(raw.path), out)
		if (name === 'grep' || name === 'glob') checkText(textOf(raw.pattern), out)
	}
	out.sort((a, b) => a.severity === 'danger' && b.severity !== 'danger' ? -1 : b.severity === 'danger' && a.severity !== 'danger' ? 1 : 0)
	return out
}

export const risk = { analyzeToolCall, checkShell, rmRfIsOnlySafeTmp }
