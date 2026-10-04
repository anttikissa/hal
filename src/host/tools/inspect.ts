// Read-only view of this host, its open tabs and models (tasks ed, jm),
// without session histories or client addresses/credentials. A bare
// call describes only the caller; scope and fields widen or narrow it.
import { projectColorNames } from '../../common/colors.ts'
import type { Tab } from '../../common/protocol.ts'
import { auth } from '../auth.ts'
import { clients, type ClientRecord } from '../clients.ts'
import { host } from '../host.ts'
import { models } from '../models.ts'
import { provider } from '../provider.ts'
import { stats } from '../stats.ts'
import { tabs } from '../tabs.ts'
import type { Tool } from '../tools.ts'
import { version } from '../version.ts'

// A model id, with until when it is rate limited on every account.
function withLimit(id: string): string {
	let until = auth.limitedUntil(id)
	return until ? `${id} (rate limited until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : id
}

const WHATS = ['sessions', 'host', 'models', 'clients']
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

function oneOf(name: string, value: unknown, valid: string[]): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string' || !valid.includes(value)) throw new Error(`${name} must be one of: ${valid.join(', ')}`)
	return value
}

function pick(value: unknown, valid: string[]): string[] {
	if (value === undefined) return valid
	let names = typeof value === 'string' ? value.split(',').map((f) => f.trim()).filter(Boolean) : []
	let bad = names.filter((f) => !valid.includes(f))
	if (!names.length || bad.length) throw new Error(`${bad.length ? `unknown field ${bad.join(', ')}; ` : ''}fields is a comma-separated list of: ${valid.join(', ')}`)
	return names
}

// One object as 'field: value' lines; several as a header and rows.
function table(fields: string[], rows: string[][]): string {
	if (rows.length === 1) return fields.map((f, i) => `${f}: ${rows[0]![i]}`).join('\n')
	return [fields.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n')
}

export const tool: Tool = {
	name: 'inspect',
	description: 'Inspect Hal read-only. what "sessions" (default): open tabs; fields tab, id, name, state, model, cwd, color (project color name), context (used/window as of the last provider response); the caller is marked "(you)". what "host": fields pid, version, started, uptime, clients (count). what "models": models by provider, the default, and which are rate limited until when. what "clients": connected clients; fields kind, pid, size (terminal columns x rows), term (TERM, terminal program, colour depth), follows (shows the caller\'s session). scope (sessions only): "self" (default, the caller), "project" (tabs sharing the caller\'s cwd) or "all". fields: comma-separated subset; default all.',
	parameters: {
		type: 'object',
		properties: {
			what: { type: 'string', enum: WHATS, description: 'sessions (default), host, models or clients' },
			scope: { type: 'string', enum: SCOPES, description: 'self (default), project or all' },
			fields: { type: 'string', description: 'Comma-separated fields, e.g. "name,cwd,context"' },
		},
	},
	async run(input, ctx) {
		let what = oneOf('what', input.what, WHATS) ?? 'sessions'
		let scope = oneOf('scope', input.scope, SCOPES) ?? 'self'
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
