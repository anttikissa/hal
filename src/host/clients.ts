// Who is connected to the host (task z8): one record per connection,
// kept in memory only. A connection that goes away stays listed as gone
// for 24 hours (its record keeps what it followed), unless the same
// client, by pid or by address and user agent, joins again.
// /clients draws them (src/host/commands/clients.ts).

import { hostname } from 'os'

export type Kind = 'own' | 'peer' | 'remote' | 'web'
export type ClientInfo = { kind: Kind; address?: string; userAgent?: string }
// `open`: the sessions the connection follows, live; `followed`: what
// it followed when it left.
export type ClientRecord = ClientInfo & { connectedAt: number; lastAt: number; open: Set<string>; pid?: number; goneAt?: number; followed?: string[] }

const goneMs = 24 * 60 * 60 * 1000

function join(open: Set<string>, info: ClientInfo = { kind: 'own' }): ClientRecord {
	let rec: ClientRecord = { ...info, connectedAt: Date.now(), lastAt: Date.now(), open }
	if (info.kind === 'own') rec.pid = process.pid
	// The same browser or remote terminal coming back replaces its gone entry.
	for (let old of clients.state.records) if (old.goneAt !== undefined && info.kind !== 'own' && info.kind !== 'peer' && old.kind === info.kind && old.address === info.address && old.userAgent === info.userAgent) clients.state.records.delete(old)
	clients.state.records.add(rec)
	return rec
}

// A peer says which process it is (the `hello` command). Only sockets
// carry peers: a browser cannot name a pid.
function hello(rec: ClientRecord, pid: number): Record<string, never> {
	if (rec.kind !== 'peer') return {}
	rec.pid = pid
	for (let old of clients.state.records) if (old.goneAt !== undefined && old.kind === 'peer' && old.pid === pid) clients.state.records.delete(old)
	return {}
}

function touch(rec: ClientRecord): void {
	rec.lastAt = Date.now()
}

function leave(rec: ClientRecord): void {
	rec.goneAt = Date.now()
	rec.followed = [...rec.open]
}

// The connection's kind and address from a WebSocket upgrade: a remote
// terminal names itself in its user agent. Behind a proxy the address
// is the first X-Forwarded-For entry.
function fromRequest(req: Request, ip?: string): ClientInfo {
	let userAgent = req.headers.get('user-agent') ?? undefined
	let address = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || ip?.replace(/^::ffff:/, '')
	let info: ClientInfo = { kind: userAgent?.startsWith('hal-terminal') ? 'remote' : 'web' }
	if (address) info.address = address
	if (userAgent) info.userAgent = userAgent
	return info
}

// "Safari on iPhone": the browser and system in a few words.
function shortAgent(ua: string | undefined): string {
	if (!ua) return 'browser'
	let browsers: [RegExp, string][] = [[/Edg\//, 'Edge'], [/OPR\//, 'Opera'], [/Firefox\/|FxiOS/, 'Firefox'], [/Chrome\/|CriOS/, 'Chrome'], [/Safari\//, 'Safari']]
	let systems: [RegExp, string][] = [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Macintosh/, 'Mac'], [/Windows/, 'Windows'], [/Linux/, 'Linux']]
	let browser = browsers.find(([re]) => re.test(ua))?.[1]
	let system = systems.find(([re]) => re.test(ua))?.[1]
	return browser && system ? `${browser} on ${system}` : (browser ?? system ?? 'browser')
}

function span(ms: number): string {
	let s = Math.floor(ms / 1000)
	if (s < 60) return `${s} s`
	if (s < 3600) return `${Math.floor(s / 60)} min`
	if (s < 86400) return `${Math.floor(s / 3600)} h`
	return `${Math.floor(s / 86400)} d`
}

function ago(ms: number): string {
	return ms < 60_000 ? 'now' : `${span(ms)} ago`
}

// A process's terminal, "ttys003"; undefined without one.
function tty(pid: number): string | undefined {
	let out = Bun.spawnSync(['ps', '-o', 'tty=', '-p', String(pid)]).stdout.toString().trim()
	return out && !out.startsWith('?') ? out : undefined
}

function follows(ids: Iterable<string>): string {
	let list = [...ids]
	return list.length === 1 ? `follows ${list[0]}` : `follows ${list.length} tabs`
}

// The diagram: the host and its live peers on one line, everyone else
// (remote terminals, browsers, anything gone) below it.
function draw(): string {
	let now = Date.now()
	for (let rec of clients.state.records) if (rec.goneAt !== undefined && now - rec.goneAt > goneMs) clients.state.records.delete(rec)
	let all = [...clients.state.records].filter((r) => r.kind !== 'own')
	let peers = all.filter((r) => r.kind === 'peer' && r.goneAt === undefined)
	let rest = all.filter((r) => !peers.includes(r)).sort((a, b) => a.connectedAt - b.connectedAt)
	let top = [`host ${process.pid} ${hostname()} (up ${span(process.uptime() * 1000)})`, ...peers.map((p) => ['peer', p.pid, p.pid === undefined ? undefined : clients.tty(p.pid)].filter((x) => x !== undefined).join(' '))]
	let rows = rest.map((r) => {
		let who = r.kind === 'peer' ? ['peer', r.pid, r.pid === undefined ? undefined : clients.tty(r.pid)] : r.kind === 'remote' ? ['remote terminal', r.address] : ['web', r.address, clients.shortAgent(r.userAgent)]
		let seen = ago(now - r.lastAt) + (r.goneAt === undefined ? '' : ' (gone)')
		return [who.filter((x) => x !== undefined).join(' '), follows(r.goneAt === undefined ? r.open : (r.followed ?? [])), seen]
	})
	let width = [0, 1].map((i) => Math.max(0, ...rows.map((row) => row[i]!.length)))
	let lines = [top.join('  <->  ')]
	if (rows.length) lines.push('    │')
	rows.forEach((row, i) => lines.push(`    ${i === rows.length - 1 ? '└' : '├'}── ${row[0]!.padEnd(width[0]!)}   ${row[1]!.padEnd(width[1]!)}   ${row[2]}`))
	return lines.join('\n')
}

function reset(): void {
	clients.state.records.clear()
}

export const clients = { state: { records: new Set<ClientRecord>() }, join, hello, touch, leave, fromRequest, shortAgent, tty, draw, reset }
