import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { settings } from '../common/settings.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { webDiagnostics } from './web-diagnostics.ts'

const report = () => ({ page: '01234567abcdef89', version: 'abc123', at: Date.now(), context: { tab: 2, tabs: 3, live: true }, entries: [{ at: Date.now(), kind: 'error', detail: 'TypeError', line: 4, column: 12 }] })

test('browser diagnostics enforce auth/origin, filter private data and rotate bounded owner-only logs', async () => {
	let saved = process.env.HAL_HOME, port = web.port
	let home = mkdtempSync(`${tmpdir()}/hal-web-diag-`)
	process.env.HAL_HOME = home; paths.init(); web.port = () => 0
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
		if (saved === undefined) delete process.env.HAL_HOME; else process.env.HAL_HOME = saved
		rmSync(home, { recursive: true, force: true })
	}
})

test('diagnostic validation rejects malformed collections and numeric state', () => {
	expect(webDiagnostics.clean({ ...report(), page: [report().page] })).toBeUndefined()
	expect(webDiagnostics.clean({ ...report(), context: { width: Infinity } })).toBeUndefined()
	expect(webDiagnostics.clean({ ...report(), entries: Array(33).fill(report().entries[0]) })).toBeUndefined()
})
