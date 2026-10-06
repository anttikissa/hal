// Real processes: the supervised host owns the lock; peers wait across
// restarts and cannot inherit it from an SSH-bound process.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '..')

test('headless host survives hangup, rejects competitors, and server peers never promote', async () => {
	let home = mkdtempSync(join(tmpdir(), 'hal-srv-'))
	let procs: Bun.Subprocess[] = []
	let reports: string[] = []
	let readers: Promise<void>[] = []
	let spawn = (argv: string[]) => {
		let p = Bun.spawn(argv, { cwd: root, env: { ...process.env, HAL_HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
		procs.push(p)
		return p
	}
	let until = async (check: () => boolean) => {
		let end = Date.now() + 5000
		while (!check()) {
			if (Date.now() > end) throw new Error(`server mode timed out: ${reports.join(', ')}`)
			await Bun.sleep(10)
		}
	}
	try {
		writeFileSync(join(home, 'config.ason'), "{ hostMode: 'server' }")
		writeFileSync(join(home, 'local.ts'), `
import { main } from ${JSON.stringify(join(root, 'src/main.ts'))}
import { resources } from ${JSON.stringify(join(root, 'src/host/resources.ts'))}
resources.init = () => {}
main.refreshModels = async () => { process.stdout.write('ready\\n') }
`)
		let peer = spawn(['bun', '-e', `
import { config } from './src/host/config.ts'
import { main } from './src/main.ts'
config.init()
main.initHost()
await main.joinHost(() => {}, (s) => process.stdout.write(s.type === 'connected' ? s.role + '\\n' : s.type + '\\n'))
`])
		readers.push((async () => {
			let buf = ''
			for await (let c of peer.stdout) {
				buf += new TextDecoder().decode(c)
				let n: number
				while ((n = buf.indexOf('\n')) >= 0) { reports.push(buf.slice(0, n)); buf = buf.slice(n + 1) }
			}
		})())
		await until(() => reports.includes('disconnected'))
		expect(existsSync(join(home, 'state/host.sock'))).toBe(false)
		// Print clients follow the same policy, even with no host available.
		let print = spawn(['bun', 'src/main.ts', '-p', 'do not run'])
		await Bun.sleep(150)
		expect(existsSync(join(home, 'state/host.sock'))).toBe(false)
		print.kill('SIGKILL')
		await print.exited

		let host = spawn(['bun', 'src/main.ts', 'serve'])
		let ready = false
		readers.push((async () => { for await (let c of host.stdout) if (new TextDecoder().decode(c).includes('ready')) ready = true })())
		await until(() => ready && reports.includes('client'))
		host.kill('SIGHUP')
		await Bun.sleep(100)
		expect(host.exitCode).toBeNull()
		let competitor = spawn(['bun', 'src/main.ts', 'serve'])
		expect(await competitor.exited).toBe(1)
		expect(await new Response(competitor.stderr).text()).toContain('another host owns this HAL_HOME')
		host.kill('SIGUSR1')
		expect(await host.exited).toBe(100)
		await until(() => reports.at(-1) === 'disconnected')
		await Bun.sleep(100)
		expect(reports).not.toContain('host')
		let before = reports.filter((r) => r === 'client').length
		let next = spawn(['bun', 'src/main.ts', 'serve'])
		await until(() => reports.filter((r) => r === 'client').length > before)
		// Exercise the actual slash-command path, not just an external signal.
		spawn(['bun', '-e', `
import { config } from './src/host/config.ts'
import { main } from './src/main.ts'
import { connection } from './src/common/connection.ts'
config.init()
main.initHost()
let requested = false
await main.joinHost((e) => {
	if (e.type === 'snapshot' && !requested) {
		requested = true
		connection.send({ type: 'submit', sessionId: e.sessionId, text: '/restart host' })
	}
})
connection.send({ type: 'create', cwd: '/tmp' })
`])
		expect(await next.exited).toBe(100)
		await until(() => reports.at(-1) === 'disconnected')
		before = reports.filter((r) => r === 'client').length
		let final = spawn(['bun', 'src/main.ts', 'serve'])
		await until(() => reports.filter((r) => r === 'client').length > before)
		final.kill('SIGTERM')
		expect(await final.exited).toBe(0)
		expect(reports).not.toContain('host')
	} finally {
		for (let p of procs) if (p.exitCode === null) p.kill('SIGKILL')
		await Promise.all(procs.map((p) => p.exited))
		await Promise.all(readers)
		rmSync(home, { recursive: true, force: true })
	}
}, 15000)

test('invalid host mode refuses promotion instead of falling back to auto', async () => {
	let home = mkdtempSync(join(tmpdir(), 'hal-srv-'))
	try {
		for (let text of ["{ hostMode: 'servre' }", "{ hostMode: 'server'"]) {
			writeFileSync(join(home, 'config.ason'), text)
			let p = Bun.spawn(['bun', 'src/main.ts', '-p', 'do not run'], { cwd: root, env: { ...process.env, HAL_HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
			expect(await p.exited).not.toBe(0)
			expect(await new Response(p.stderr).text()).toContain('config.ason')
			expect(existsSync(join(home, 'state/host.sock'))).toBe(false)
		}
	} finally { rmSync(home, { recursive: true, force: true }) }
})
