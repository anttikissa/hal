// Cookie/origin checks are web.ts's job. Bound and project untrusted reports
// before logging; arbitrary fields, error messages and URL strings never land.
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from 'fs'
import { diagnosticBooleans, diagnosticDetails, diagnosticKinds, diagnosticNumbers, type BrowserReport } from '../common/web-diagnostics.ts'
import { paths } from './paths.ts'
import { settings } from '../common/settings.ts'

const limit = 1024 * 1024
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function clean(v: unknown): BrowserReport | undefined {
	if (!object(v) || typeof v.page !== 'string' || !/^[a-z0-9]{8,32}$/.test(v.page) || typeof v.version !== 'string' || !/^[a-z0-9]{1,32}$/.test(v.version) || !number(v.at) || !object(v.context) || !Array.isArray(v.entries) || v.entries.length > 32) return
	let context: BrowserReport['context'] = {}
	for (let key of diagnosticNumbers) { if (v.context[key] !== undefined && !number(v.context[key])) return; if (v.context[key] !== undefined) context[key] = v.context[key] }
	for (let key of diagnosticBooleans) { if (v.context[key] !== undefined && typeof v.context[key] !== 'boolean') return; if (v.context[key] !== undefined) context[key] = v.context[key] }
	let entries: BrowserReport['entries'] = []
	for (let e of v.entries) {
		if (!object(e) || !number(e.at) || (e.line !== undefined && !number(e.line)) || (e.column !== undefined && !number(e.column))) return
		// A page newer than this host may know labels it does not: skip them.
		if (!diagnosticKinds.includes(e.kind) || !diagnosticDetails.includes(e.detail)) continue
		let entry = { at: e.at, kind: e.kind, detail: e.detail } as BrowserReport['entries'][number]
		for (let key of ['line', 'column', 'ms', 'bytes', 'tab'] as const) {
			if (e[key] !== undefined && !number(e[key])) return
			if (e[key] !== undefined) entry[key] = e[key]
		}
		entries.push(entry)
	}
	return { page: v.page, version: v.version, at: v.at, context, entries }
}

let windowAt = 0, received = 0
async function receive(req: Request): Promise<Response> {
	if (!req.headers.get('content-type')?.startsWith('application/json')) return new Response(null, { status: 415 })
	let now = Date.now()
	if (now - windowAt > 60_000) { windowAt = now; received = 0 }
	if (++received > 30) return new Response(null, { status: 429 })
	if (Number(req.headers.get('content-length')) > 16_384) return new Response(null, { status: 413 })
	let reader = req.body?.getReader(), chunks: Uint8Array[] = [], size = 0
	if (!reader) return new Response(null, { status: 400 })
	try {
		while (true) {
			let { done, value } = await reader.read()
			if (done || !value) break
			size += value.length
			if (size > 16_384) { await reader.cancel(); return new Response(null, { status: 413 }) }
			chunks.push(value)
		}
		let report = clean(JSON.parse(Buffer.concat(chunks).toString('utf8')))
		if (!report) return new Response(null, { status: 400 })
		webDiagnostics.write(report)
		return new Response(null, { status: 204 })
	} catch { return new Response(null, { status: 400 }) }
}

function write(report: BrowserReport): void {
	let file = `${paths.stateDir()}/web-diag.log`, line = `${new Date().toISOString()} ${JSON.stringify(report)}\n`
	if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > limit) renameSync(file, `${file}.1`)
	appendFileSync(file, line, { mode: 0o600 })
	chmodSync(file, 0o600)
}

function load(tab: number, detail: 'requested' | 'ready' | 'tail' | 'built' | 'encoded', start: number, bytes?: number): void {
	if (!settings.webDiagnostics()) return
	let at = Date.now()
	webDiagnostics.write({ page: 'host0000', version: 'host', at, context: {}, entries: [{ at, kind: 'load', detail, tab, ms: Math.max(0, performance.now() - start), ...(bytes !== undefined && { bytes }) }] })
}

// Opt-in composer probe (web/composer-debug.ts): the user's own logged-in
// page, so rows (draft text included) are kept as sent, one JSON line each,
// bounded per request and by file rotation.
async function composer(req: Request): Promise<Response> {
	if (!req.headers.get('content-type')?.startsWith('application/json')) return new Response('expected JSON\n', { status: 415 })
	if (Number(req.headers.get('content-length')) > 4 * 1024 * 1024) return new Response('too large\n', { status: 413 })
	let text = await req.text()
	if (text.length > 4 * 1024 * 1024) return new Response('too large\n', { status: 413 })
	let body: unknown
	try { body = JSON.parse(text) } catch (error) { return new Response(`bad JSON: ${String(error)}\n`, { status: 400 }) }
	if (!object(body) || !Array.isArray(body.rows) || body.rows.length > 100) return new Response('expected { rows: [...] } with at most 100 rows\n', { status: 400 })
	let file = `${paths.stateDir()}/composer-debug.log`
	let lines = body.rows.map((row) => `${JSON.stringify({ page: body.page, ua: body.ua, ...(object(row) ? row : { row }) })}\n`).join('')
	if (existsSync(file) && statSync(file).size + Buffer.byteLength(lines) > 16 * limit) renameSync(file, `${file}.1`)
	appendFileSync(file, lines, { mode: 0o600 })
	return new Response(null, { status: 204 })
}

export const webDiagnostics = { clean, receive, write, load, composer, reset: () => { windowAt = 0; received = 0 } }
