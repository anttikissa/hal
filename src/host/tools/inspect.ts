// Read-only view of this host, its open tabs and models (tasks ed, jm),
// without session histories or client addresses/credentials. A bare
// call describes only the caller; scope and fields widen or narrow it.
// INSPECT "tabs" lists every tab: models sent it by mistake (task qzh).
import { callText } from '../../common/call-text.ts'
import { projectColorNames } from '../../common/colors.ts'
import type { Tab } from '../../common/protocol.ts'
import { nativeTool } from '../native-tool.ts'
import { auth } from '../auth.ts'
import { clients, type ClientRecord } from '../clients.ts'
import { fileEditors } from '../file-editors.ts'
import { host } from '../host.ts'
import { limits } from '../limits.ts'
import { models } from '../models.ts'
import { provider } from '../provider.ts'
import { stats } from '../stats.ts'
import { statusUsage, type UsageRow } from '../status-usage.ts'
import { tabs } from '../tabs.ts'
import type { Tool, ToolOutput } from '../tools.ts'
import { version } from '../version.ts'
import { work } from '../work.ts'

// A model id, with until when it is rate limited on every account.
function withLimit(id: string): string {
	let until = auth.limitedUntil(id)
	return until ? `${id} (rate limited until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : id
}

const WHATS = ['sessions', 'host', 'models', 'clients', 'subscriptions', 'files']
const SCOPES = ['self', 'project', 'all']

// Compact token counts as on the status row: 950, 87k, 1000k.
const kilo = (n: number) => n < 1000 ? String(n) : `${Math.round(n / 1000)}k`

function context(id: string): string {
	let s = stats.of(id)
	if (!s.context) return 'none'
	return s.window ? `${kilo(s.context)}/${kilo(s.window)} (${Math.round(s.context / s.window * 100)}%)` : kilo(s.context)
}

const SESSION: Record<string, (t: Tab, i: number) => string> = {
	tab: (_, i) => String(i + 1),
	id: (t) => t.id,
	name: (t) => t.name,
	state: (t) => t.state.type === 'running' ? `running (${t.state.phase})` : t.state.type === 'blocked' ? `asking (${t.state.reason})` : t.state.type,
	model: (t) => t.model,
	cwd: (t) => t.cwd,
	color: (t) => t.color === undefined ? 'none' : projectColorNames[t.color] ?? String(t.color),
	context: (t) => context(t.id),
}

const HOST: Record<string, () => string> = {
	pid: () => String(process.pid),
	version: () => version.state.loaded ?? 'unknown',
	started: () => new Date(performance.timeOrigin).toISOString(),
	uptime: () => `${Math.floor(process.uptime())}s`,
	clients: () => String(host.state.clients.size),
}

// Connected clients; `follows`: whether it shows the calling session.
const CLIENT: Record<string, (c: ClientRecord, self: string) => string> = {
	kind: (c) => c.kind === 'own' ? 'terminal (host process)' : c.kind === 'peer' ? 'terminal' : c.kind === 'remote' ? 'remote terminal' : 'web',
	pid: (c) => c.pid === undefined ? 'none' : String(c.pid),
	size: (c) => c.screen ? `${c.screen.cols}x${c.screen.rows}` : 'unknown',
	term: (c) => c.screen?.term ?? 'unknown',
	follows: (c, self) => c.open.has(self) ? 'yes' : 'no',
}

const SUBSCRIPTION: Record<string, (row: UsageRow) => string> = {
	provider: (r) => r.provider,
	slot: (r) => r.slot,
	account: (r) => r.account,
	plan: (r) => r.apiKey ? 'not applicable' : r.subscriptionPlan ?? 'unknown',
	status: (r) => {
		if (r.apiKey) return 'API key (not queried)'
		if (r.refreshError) return `${statusUsage.problem(r.refreshError).text}; ${Object.keys(r.windows).length ? 'showing cached usage' : 'usage unavailable'}${r.loginRequired ? '; run /login ' + (r.provider === 'anthropic' ? 'claude' : 'chatgpt') : ''}`
		let status = !Object.keys(r.windows).length ? 'usage unavailable' : Object.values(r.windows).some((w) => w.used >= 100) ? 'quota exhausted' : 'ok'
		return `${status}${r.error ? `; ${r.error}` : ''}`
	},
	windows: (r) => r.apiKey ? 'not applicable' : [...new Set(['5h', '7d', ...Object.keys(r.windows)])].map((name) => {
		let w = r.windows[name]
		return `${name}: ${w ? `${w.used}% used; resets ${w.resets ?? 'unknown'}; observed ${w.observed ?? 'unknown'}` : 'unknown'}${r.refreshError ? ' (cached)' : ''}`
	}).join('\n'),
	limits: (r) => Object.entries(limits.store()).filter(([key]) => limits.ofKind(key, r.provider) && key.slice(key.indexOf(' ') + 1) === r.account && limits.until(key) > 0).map(([key, at]) => `${key.slice(0, key.indexOf(' '))}: until ${at}`).join('\n') || 'none recorded',
	error: (r) => r.refreshError ?? 'none',
}

const usage = () => `\n\nUsage:\n${nativeTool.usage(tool).map((u) => `  ${u}`).join('\n')}`

function oneOf(name: string, value: unknown, valid: string[]): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string' || !valid.includes(value)) throw new Error(`INSPECT ${name} must be one of: ${valid.join(', ')}.${usage()}`)
	return value
}

function pick(value: unknown, valid: string[]): string[] {
	if (value === undefined) return valid
	let names = typeof value === 'string' ? value.split(',').map((f) => f.trim()).filter(Boolean) : []
	let bad = names.filter((f) => !valid.includes(f))
	if (!names.length || bad.length) throw new Error(`${bad.length ? `unknown field ${bad.join(', ')}; ` : ''}fields is a comma-separated list of: ${valid.join(', ')}.${usage()}`)
	return names
}

// One object as 'field: value' lines; several as a header and rows.
function table(fields: string[], rows: string[][]): string {
	if (rows.length === 1) return fields.map((f, i) => `${f}: ${rows[0]![i]}`).join('\n')
	return [fields.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n')
}

export const tool: Tool<ToolOutput> = {
	name: 'inspect',
	syntax: {
		summary: 'agent internals and subscription status',
		// Plain words fill what, scope, fields in order; HELP shows the object form.
		positional: ['what', 'scope', 'fields'],
		usage: ['INSPECT "<session id> | <tool call id>"    // e.g. INSPECT 12-xyz, INSPECT t150', 'INSPECT "subscriptions"', 'INSPECT [ { what, scope, fields } ]'],
		resolve: (raw) => {
			let { values } = callText.values(raw)
			if (values.length === 1 && values[0] === 'tabs') return { name: 'inspect', input: { what: 'sessions', scope: 'all' } }
			if (values.length === 1 && work.isTarget(values[0])) return { name: 'inspect', input: { target: values[0] } }
			let input = nativeTool.generic(tool, raw)
			// A lone unknown word was meant as a target or topic; say so in those terms.
			if (values.length === 1 && typeof values[0] === 'string' && !WHATS.includes(values[0])) throw new Error(`INSPECT ${JSON.stringify(values[0])}: not a session ID, tool call ID or one of ${WHATS.join(', ')}.${usage()}`)
			return { name: 'inspect', input }
		},
	},
	description: 'Inspect Hal read-only. what "sessions" (default): open tabs; fields tab, id, name, state, model, cwd, color (project color name), context (used/window as of the last provider response); the caller is marked "(you)". what "host": fields pid, version, started, uptime, clients (count). what "models": models by provider, the default, and which are rate limited until when. what "clients": connected clients; fields kind, pid, size (terminal columns x rows), term (TERM, terminal program, color depth), follows (shows the calling session). what "subscriptions": refresh every configured Anthropic and OpenAI subscription without a model request; fields provider, slot (* marks the caller-selected or preferred account), account, plan (unknown when not reported), status, windows (percent used, ISO resets and observations; cached on failure), limits (recorded account/model skips), error (complete safe refresh failure, always included on failure). API keys are listed, not queried. Refresh failures mark the tool result as an error without hiding other accounts. what "files": uncommitted files of the caller\'s Git root, each with every session and call that declared and changed it since its last commit, newest first, and whether the file still matches the newest; scope "all" adds files Hal changed outside the root. scope (sessions only): "self" (default, the caller), "project" (tabs sharing the calling cwd) or "all". fields: comma-separated subset; default all.',
	parameters: {
		type: 'object',
		properties: {
			target: { type: 'string', description: 'Session ID or local tool-call reference (#t123, t123 or 123): status, available output and pending question. Bare numbers mean tool calls, not tabs. Cannot combine with what, scope or fields.' },
			what: { type: 'string', enum: WHATS, description: 'sessions (default), host, models, clients, subscriptions or files' },
			scope: { type: 'string', enum: SCOPES, description: 'self (default; files: project), project or all' },
			fields: { type: 'string', description: 'Comma-separated fields, e.g. "name,cwd,context"' },
		},
	},
	async run(input, ctx) {
		if (input.target !== undefined) {
			if ([input.what, input.scope, input.fields].some((v) => v !== undefined)) throw new Error('INSPECT target cannot be combined with what, scope or fields.')
			return work.inspect(work.target(ctx.sessionId, input.target))
		}
		let what = oneOf('what', input.what, WHATS) ?? 'sessions'
		let scope = oneOf('scope', input.scope, SCOPES) ?? (what === 'files' ? 'project' : 'self')
		if (what === 'files') {
			if (scope === 'self' || input.fields !== undefined) throw new Error(`INSPECT files takes scope "project" (default, uncommitted files of the Git root) or "all" (also files Hal changed outside it), and no fields.${usage()}`)
			return fileEditors.report(ctx.cwd, scope as 'project' | 'all', clients.timezone(ctx.sessionId))
		}
		if (what === 'subscriptions') {
			let fields = pick(input.fields, Object.keys(SUBSCRIPTION))
			let rows = await statusUsage.rows(ctx.sessionId, ctx.model ?? tabs.list().find((t) => t.id === ctx.sessionId)?.model ?? '')
			return { text: rows.length ? rows.map((r) => {
				let shown = r.refreshError && !fields.includes('error') ? [...fields, 'error'] : fields
				return table(shown, [shown.map((f) => SUBSCRIPTION[f]!(r))])
			}).join('\n\n') : 'No accounts configured.', isError: rows.some((r) => r.refreshError !== undefined) }
		}
		if (what === 'models') {
			let ids = models.known()
			let lines = [`Default: ${models.defaultModel()}`]
			for (let name of ['hal', ...Object.keys(provider.state.providers)]) {
				lines.push(`${name}: ${ids.filter((id) => id.startsWith(`${name}/`)).map(withLimit).join(', ') || '(none listed)'}`)
			}
			return lines.join('\n')
		}
		if (what === 'clients') {
			let fields = pick(input.fields, Object.keys(CLIENT))
			let list = [...clients.state.records].filter((c) => c.goneAt === undefined)
			return list.length ? table(fields, list.map((c) => fields.map((f) => CLIENT[f]!(c, ctx.sessionId)))) : 'No clients connected.'
		}
		if (what === 'host') {
			let fields = pick(input.fields, Object.keys(HOST))
			return table(fields, [fields.map((f) => HOST[f]!())])
		}
		let fields = pick(input.fields, Object.keys(SESSION))
		let list = tabs.list()
		let self = list.find((t) => t.id === ctx.sessionId)
		let rows = list.flatMap((t, i) => {
			if (scope === 'self' ? t.id !== ctx.sessionId : scope === 'project' ? t.cwd !== (self?.cwd ?? ctx.cwd) : false) return []
			return [fields.map((f) => SESSION[f]!(t, i) + (f === 'id' && t.id === ctx.sessionId ? ' (you)' : ''))]
		})
		if (!rows.length) return scope === 'self' ? 'This session is not an open tab.' : 'No open tabs.'
		return table(fields, rows)
	},
}
