// Several real processes on one temp home: exactly one is host, the rest
// are clients, and killing the host in any way hands over to one survivor
// that the others reconnect to.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

type Report = { role?: 'host' | 'client' | null; snapshot?: string; child?: number }
type Proc = { sub: Bun.Subprocess<'ignore', 'pipe', 'pipe'>; reports: Report[]; dead: boolean; read: Promise<void> }

// Each process joins, creates a session of its own and reports every role
// change and snapshot. As host it also starts a long-lived child process,
// which must not keep the host lock alive after the host dies.
const script = `
import { main } from ${JSON.stringify(`${import.meta.dir}/main.ts`)}
import { link } from ${JSON.stringify(`${import.meta.dir}/client/link.ts`)}
let say = (r) => process.stdout.write(JSON.stringify(r) + '\\n')
main.init()
await main.joinHost(
	(e) => { if (e.type === 'snapshot') say({ snapshot: e.sessionId }) },
	(role) => {
		say({ role })
		if (role === 'host') say({ child: Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'] }).pid })
	},
)
link.send({ type: 'create', cwd: '/tmp' })
`

let home = ''
let procs: Proc[] = []

afterEach(async () => {
	for (let p of procs) p.sub.kill('SIGKILL')
	await Promise.all(procs.map((p) => p.sub.exited))
	// Every child pid a process reported before it died.
	await Promise.all(procs.map((p) => p.read))
	for (let p of procs) for (let r of p.reports) if (r.child) killQuietly(r.child)
	procs = []
	rmSync(home, { recursive: true, force: true })
})

function killQuietly(pid: number): void {
	try {
		process.kill(pid, 'SIGKILL')
	} catch {}
}

function spawn(): Proc {
	let sub = Bun.spawn(['bun', '-e', script], {
		env: { ...process.env, HAL_HOME: home },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	let p: Proc = { sub, reports: [], dead: false, read: Promise.resolve() }
	p.read = (async () => {
		let buf = ''
		for await (let chunk of sub.stdout) {
			buf += new TextDecoder().decode(chunk)
			let nl: number
			while ((nl = buf.indexOf('\n')) >= 0) {
				p.reports.push(JSON.parse(buf.slice(0, nl)))
				buf = buf.slice(nl + 1)
			}
		}
	})()
	void sub.exited.then(() => (p.dead = true))
	procs.push(p)
	return p
}

const role = (p: Proc) => p.reports.findLast((r) => r.role !== undefined)?.role
const snapshots = (p: Proc) => p.reports.filter((r) => r.snapshot).length
const alive = () => procs.filter((p) => !p.dead)
const hosts = () => alive().filter((p) => role(p) === 'host')

async function until(what: string, check: () => boolean): Promise<void> {
	let deadline = Date.now() + 10_000
	while (!check()) {
		if (Date.now() > deadline) {
			let stderr = await Promise.all(procs.map(async (p) => (p.dead ? await new Response(p.sub.stderr).text() : '')))
			throw new Error(`timed out waiting for ${what}\n${JSON.stringify(procs.map((p) => p.reports))}\n${stderr.join('\n')}`)
		}
		await Bun.sleep(10)
	}
}

// Every live process has a role, and has seen a snapshot since `since`.
async function settled(since: Map<Proc, number>): Promise<void> {
	await until('every process to (re)connect', () =>
		alive().every((p) => role(p) && snapshots(p) > (since.get(p) ?? 0)),
	)
	// Let any late second claim show up before counting hosts.
	await Bun.sleep(100)
	expect(hosts().length).toBe(1)
	expect(alive().every((p) => role(p))).toBe(true)
}

test('killing the host always leaves one host with every client reconnected', async () => {
	home = mkdtempSync(`${tmpdir()}/hal-join-`)
	// Started together, so they race for the lock on a fresh home.
	for (let i = 0; i < 5; i++) spawn()
	await settled(new Map())
	expect(alive().filter((p) => role(p) === 'client').length).toBe(4)

	for (let signal of ['SIGKILL', 'SIGTERM', 'SIGKILL', 'SIGKILL'] as const) {
		let [old] = hosts()
		let before = new Map(alive().map((p) => [p, snapshots(p)]))
		old!.sub.kill(signal)
		await old!.sub.exited
		await settled(before)
		expect(hosts()[0]).not.toBe(old)
	}
	expect(alive().length).toBe(1)
}, 60_000)

test('a process joining later becomes a client of the running host', async () => {
	home = mkdtempSync(`${tmpdir()}/hal-join-`)
	let first = spawn()
	await until('a host', () => role(first) === 'host')
	let second = spawn()
	await until('the second to connect', () => role(second) === 'client' && snapshots(second) > 0)
	expect(hosts()).toEqual([first])
}, 30_000)
