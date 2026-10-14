// Real processes: hal serve takes the home from a peer host by asking it
// to hand over; the restarted peer stays a client; a second hal serve is
// refused, so the first prevails (task kp0).
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '..')

test('hal serve takes the home from a peer host, which then stays a client; a second hal serve is refused', async () => {
	let home = mkdtempSync(join(tmpdir(), 'hal-srv-'))
	let procs: Bun.Subprocess[] = []
	let readers: Promise<void>[] = []
	let spawn = (argv: string[]) => {
		let p = Bun.spawn([...argv, '--home', home], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
		procs.push(p)
		return p
	}
	// Lines a process prints, as they arrive.
	let lines = (p: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) => {
		let seen: string[] = []
		readers.push((async () => {
			let buf = ''
			for await (let c of p.stdout) {
				buf += new TextDecoder().decode(c)
				let n: number
				while ((n = buf.indexOf('\n')) >= 0) { seen.push(buf.slice(0, n)); buf = buf.slice(n + 1) }
			}
		})())
		return seen
	}
	let until = async (check: () => boolean, what: string) => {
		let end = Date.now() + 5000
		while (!check()) {
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
			await Bun.sleep(10)
		}
	}
	// A peer that reports its role, as a terminal joins.
	let peer = () => lines(spawn(['bun', '-e', `
import { paths } from './src/host/paths.ts'
paths.state.home = ${JSON.stringify(home)}
import { config } from './src/host/config.ts'
import { main } from './src/main.ts'
config.init()
main.initHost()
await main.joinHost(() => {}, (s) => process.stdout.write(s.type === 'connected' ? s.role + '\\n' : s.type + '\\n'))
`]))
	try {
		writeFileSync(join(home, 'local.ts'), `
import { main } from ${JSON.stringify(join(root, 'src/main.ts'))}
import { resources } from ${JSON.stringify(join(root, 'src/host/resources.ts'))}
resources.init = () => {}
main.refreshModels = async () => { process.stdout.write('ready\\n') }
`)
		let first = peer()
		await until(() => first.includes('host'), 'the first peer to host')
		let firstProc = procs.at(-1)!

		let serve = spawn(['bun', 'src/main.ts', 'serve'])
		let served = lines(serve)
		expect(await firstProc.exited).toBe(100)
		await until(() => served.includes('ready'), 'hal serve to host')
		serve.kill('SIGHUP')
		await Bun.sleep(100)
		expect(serve.exitCode).toBeNull()

		let second = peer()
		await until(() => second.includes('client'), 'the restarted peer to join')
		expect(second).not.toContain('host')

		let competitor = spawn(['bun', 'src/main.ts', 'serve'])
		expect(await competitor.exited).toBe(1)
		expect(await new Response(competitor.stderr).text()).toContain('hal serve already hosts this home')

		serve.kill('SIGTERM')
		expect(await serve.exited).toBe(0)
		expect(existsSync(join(home, 'state/handover'))).toBe(false)
	} finally {
		for (let p of procs) if (p.exitCode === null) p.kill('SIGKILL')
		await Promise.all(procs.map((p) => p.exited))
		await Promise.all(readers)
		rmSync(home, { recursive: true, force: true })
	}
}, 20000)

test('a broken config.ason refuses promotion instead of ignoring it', async () => {
	let home = mkdtempSync(join(tmpdir(), 'hal-srv-'))
	try {
		writeFileSync(join(home, 'config.ason'), '{ webPort: 9001')
		let p = Bun.spawn(['bun', 'src/main.ts', '-p', 'do not run', '--home', home], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
		expect(await p.exited).not.toBe(0)
		expect(await new Response(p.stderr).text()).toContain('config.ason')
		expect(existsSync(join(home, 'state/host.sock'))).toBe(false)
	} finally { rmSync(home, { recursive: true, force: true }) }
})
