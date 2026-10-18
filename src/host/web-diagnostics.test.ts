// Browser diagnostic privacy validation, transport limits and causal retention.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { Breadcrumb } from '../common/web-diagnostics.ts'
import { retain } from '../web/diagnostics.ts'
import { settings } from '../common/settings.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { webDiagnostics } from './web-diagnostics.ts'

const report = () => ({ page: '01234567abcdef89', version: 'abc123', at: Date.now(), context: { tab: 2, tabs: 3, live: true }, entries: [{ at: Date.now(), kind: 'error', detail: 'TypeError', line: 4, column: 12 }] })

test('browser diagnostics enforce auth/origin, filter private data and rotate bounded owner-only logs', async () => {
	let saved = paths.state.home, port = web.port
	let home = mkdtempSync(`${tmpdir()}/hal-web-diag-`)
	paths.state.home = home; paths.init(); web.port = () => 0
	try {
		await server.serve(); web.start()
		let base = `http://127.0.0.1:${web.state.server!.port}`
		let login = new FormData(); login.set('code', webAuth.issue())
		let auth = await fetch(`${base}/login`, { method: 'POST', body: login })
		let cookie = auth.headers.get('set-cookie')!.split(';')[0]!
		let post = (body: string, headers: Record<string, string> = {}) => fetch(`${base}/web-diagnostics`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })
		let body = JSON.stringify(report())
		let headers = { cookie, origin: base }
		// Opt-in: off by default, nothing is accepted or written.
		expect((await post(body, headers)).status).toBe(404)
		expect(existsSync(`${paths.stateDir()}/web-diag.log`)).toBe(false)
		settings.state.raw = { webDiagnostics: true }
		expect((await post(body)).status).toBe(401)
		expect((await post(body, { cookie, origin: 'https://wrong.example' })).status).toBe(403)
		expect((await post('{', headers)).status).toBe(400)
		// An unknown label (a newer page's, or text) is skipped, never logged.
		expect((await post(JSON.stringify({ ...report(), entries: [{ at: 1, kind: 'error', detail: 'private message' }] }), headers)).status).toBe(204)
		expect((await post('x'.repeat(16_385), headers)).status).toBe(413)
		let dirty = { ...report(), url: 'https://private.example/?auth=secret', draft: 'private draft', context: { ...report().context, text: 'private prompt' }, entries: [{ ...report().entries[0], message: 'private error', stack: 'private URL' }] }
		expect((await post(JSON.stringify(dirty), headers)).status).toBe(204)
		let file = `${paths.stateDir()}/web-diag.log`, logged = readFileSync(file, 'utf8')
		expect(logged).not.toContain('private')
		expect(logged).not.toContain('secret')
		expect(logged).toContain('TypeError')
		expect(statSync(file).mode & 0o777).toBe(0o600)
		writeFileSync(file, 'x'.repeat(1024 * 1024))
		expect((await post(body, headers)).status).toBe(204)
		expect(statSync(`${file}.1`).size).toBe(1024 * 1024)
		expect(statSync(file).size).toBeLessThan(16_384)
		for (let i = 0; i < 30; i++) await post(body, headers)
		expect((await post(body, headers)).status).toBe(429)
	} finally {
		await server.stop(); host.reset(); web.port = port; settings.state.raw = {}
		if (saved === undefined) paths.state.home = undefined; else paths.state.home = saved
		rmSync(home, { recursive: true, force: true })
	}
})

test('diagnostic validation rejects malformed collections and numeric state', () => {
	expect(webDiagnostics.clean({ ...report(), page: [report().page] })).toBeUndefined()
	expect(webDiagnostics.clean({ ...report(), context: { width: Infinity } })).toBeUndefined()
	for (let key of ['ms', 'bytes', 'tab']) {
		expect(webDiagnostics.clean({ ...report(), entries: [{ at: 1, kind: 'load', detail: 'parsed', [key]: -1 }] })).toBeUndefined()
	}
	let cleaned = webDiagnostics.clean({ ...report(), entries: [{ at: 1, kind: 'load', detail: 'parsed', ms: 2.5, bytes: 10, tab: 3, text: 'private' }] })
	expect(cleaned?.entries).toEqual([{ at: 1, kind: 'load', detail: 'parsed', ms: 2.5, bytes: 10, tab: 3 }])
	expect(webDiagnostics.clean({ ...report(), entries: Array(33).fill(report().entries[0]) })).toBeUndefined()
})

test('scroll diagnostics project structural snapshots without leaking arbitrary causes or fields', () => {
	let entry = { at: 1, kind: 'pulled', detail: 'visible', cause: 'resize', scroll: { top: 5, height: 100, client: 80, gap: 15, pinned: false, held: false, intent: true } } satisfies Breadcrumb
	let clean = (e: unknown) => webDiagnostics.clean({ ...report(), entries: [e] })
	expect(clean({ ...entry, scroll: { ...entry.scroll, text: 'private' } })?.entries).toEqual([entry])
	expect(clean({ ...entry, cause: 'private' })?.entries[0]?.cause).toBeUndefined()
	for (let scroll of [null, [], { top: -1 }, { gap: Infinity }, { height: 'private' }, { pinned: 1 }]) expect(clean({ ...entry, scroll })).toBeUndefined()
	expect(clean({ ...entry, kind: 'newer-kind' })?.entries).toEqual([])
})

test('scroll causes survive generic event floods and failed-batch merges within 32 entries', () => {
	let entries: Breadcrumb[] = [], dropped = 0
	for (let at = 0; at < 100; at++) {
		entries.push({ at, kind: at === 0 ? 'pin' : at < 15 ? 'scroll' : 'event', detail: 'other' })
		dropped += retain(entries)
	}
	expect(entries[0]?.kind).toBe('pin')
	expect(entries.filter((e) => e.kind === 'scroll').map((e) => e.at)).toEqual(Array.from({ length: 12 }, (_, i) => i + 3))
	expect(entries.length).toBe(32)
	expect(dropped).toBe(68)
	let merged = [...entries, ...Array.from({ length: 32 }, (_, i): Breadcrumb => ({ at: 100 + i, kind: 'event', detail: 'other' }))]
	expect(retain(merged)).toBe(32)
	expect(merged.slice(0, 12)).toEqual(entries.slice(0, 12))
	expect(merged.map((e) => e.at)).toEqual(merged.map((e) => e.at).sort((a, b) => a - b))
	// A wheel flood never evicts the pin change that caused it.
	for (let at = 200; at < 300; at++) { merged.push({ at, kind: 'scroll', detail: 'other' }); retain(merged) }
	expect(merged[0]?.kind).toBe('pin')
})
