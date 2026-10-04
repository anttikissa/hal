// Cookie/origin checks are web.ts's job. Bound and project untrusted reports
// before logging; arbitrary fields, error messages and URL strings never land.
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from 'fs'
import { diagnosticBooleans, diagnosticDetails, diagnosticKinds, diagnosticNumbers, type BrowserReport } from '../common/web-diagnostics.ts'
import { paths } from './paths.ts'

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
		entries.push({ at: e.at, kind: e.kind, detail: e.detail, ...(e.line !== undefined && { line: e.line }), ...(e.column !== undefined && { column: e.column }) })
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
		let file = `${paths.stateDir()}/web-diag.log`, line = `${new Date().toISOString()} ${JSON.stringify(report)}\n`
		if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > limit) renameSync(file, `${file}.1`)
		appendFileSync(file, line, { mode: 0o600 })
		chmodSync(file, 0o600)
		return new Response(null, { status: 204 })
	} catch { return new Response(null, { status: 400 }) }
}

export const webDiagnostics = { clean, receive, reset: () => { windowAt = 0; received = 0 } }
