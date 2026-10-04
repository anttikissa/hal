import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { secrets } from './secrets.ts'

const saved = process.env.HAL_HOME
let home = ''

afterEach(() => {
	if (saved === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = saved
	rmSync(home, { recursive: true, force: true })
})

const mode = (p: string) => statSync(p).mode & 0o777

test('migration moves old credential files into an owner-only secrets/ and never overwrites a new one', () => {
	home = process.env.HAL_HOME = mkdtempSync(`${tmpdir()}/hal-secrets-`)
	mkdirSync(`${home}/state`)
	mkdirSync(`${home}/secrets`, { mode: 0o755 })
	writeFileSync(`${home}/auth.ason`, "{ old: 'a' }\n", { mode: 0o644 })
	writeFileSync(`${home}/state/push-vapid.ason`, "{ old: 'v' }\n")
	writeFileSync(`${home}/secrets/push-vapid.ason`, "{ new: 'v' }\n")
	paths.init()
	secrets.migrate(['auth.ason', 'state/push-vapid.ason', 'state/push-subscriptions.ason'])
	expect(mode(`${home}/secrets`)).toBe(0o700)
	expect(existsSync(`${home}/auth.ason`)).toBe(false)
	expect(readFileSync(paths.authFile(), 'utf8')).toBe("{ old: 'a' }\n")
	expect(mode(paths.authFile())).toBe(0o600)
	// Both exist: the new one wins, the old one stays and is named once.
	expect(readFileSync(`${home}/secrets/push-vapid.ason`, 'utf8')).toBe("{ new: 'v' }\n")
	expect(existsSync(`${home}/state/push-vapid.ason`)).toBe(true)
	let lines = readFileSync(`${home}/state/diag.log`, 'utf8').trim().split('\n')
	expect(lines).toHaveLength(1)
	expect(lines[0]).toContain(`${home}/state/push-vapid.ason`)
	expect(existsSync(`${home}/secrets/push-subscriptions.ason`)).toBe(false)
})

test('secret files are written 0600 and only inside secrets/', () => {
	home = process.env.HAL_HOME = mkdtempSync(`${tmpdir()}/hal-secrets-`)
	expect(() => secrets.file(`${home}/state/x.ason`, {})).toThrow('is not in')
	let data = secrets.file<{ k?: string }>(`${paths.secretsDir()}/x.ason`, {}, { watch: false })
	chmodSync(paths.secretsDir(), 0o755)
	data.k = 'fake'
	liveFiles.save(data)
	liveFiles.close(data)
	expect(mode(`${paths.secretsDir()}/x.ason`)).toBe(0o600)
	liveFiles.close(secrets.file(`${paths.secretsDir()}/x.ason`, {}, { watch: false }))
	expect(mode(paths.secretsDir())).toBe(0o700)
})
