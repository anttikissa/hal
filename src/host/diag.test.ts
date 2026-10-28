import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { diag } from './diag.ts'
import { paths } from './paths.ts'

const saved = paths.state.home
let home = ''

afterEach(() => {
	if (saved === undefined) paths.state.home = undefined
	else paths.state.home = saved
	rmSync(home, { recursive: true, force: true })
})

test('diagnostics land redacted in owner-only state/, not in sessions/', () => {
	home = mkdtempSync(`${tmpdir()}/hal-diag-`)
	paths.state.home = home
	paths.init()
	let token = 'sk-ant-api03-Qw3rTy0123456789abcdefXYZ'
	diag.log(`refresh failed for ${token}`)
	diag.log('second line')
	expect(diag.file().startsWith(`${paths.stateDir()}/`)).toBe(true)
	let text = readFileSync(diag.file(), 'utf8')
	expect(text).not.toContain(token)
	expect(text).toContain('refresh failed for [redacted]')
	expect(text.trim().split('\n')).toHaveLength(2)
	expect(statSync(diag.file()).mode & 0o077).toBe(0)
	expect(readdirSync(paths.sessionsDir())).toEqual([])
})

// Timebomb, task p2p: web.dropped logs to learn how often phones fall
// behind. Do not just move the date.
test('review the dropped-events logging by 2026-12-01', () => {
	let why =
		'grep "dropped events" state/diag.log: if drops are rare, delete web.dropped and this test; if not, find why clients fall behind. Keep closeOnBackpressureLimit.'
	expect(Date.now() < Date.parse('2026-12-01'), why).toBe(true)
})
