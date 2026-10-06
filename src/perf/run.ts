// scripts/perf (task te): measures Hal on a generated heavy home (task
// y9) as host (cold, then warm), as a peer, switching tabs, over -r and
// in the web client, and prints one table. Never run by ./test; no real
// data. Exits 1 if a budget is missed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { perfHome } from './home.ts'

const repo = `${import.meta.dir}/../..`
const run = `${repo}/run`
const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g, '')
const keys = '§¶ØÆ¤µ'

type Term = { exited(): boolean; write(s: string): void; screen(): string; clear(): void; rss(): number; stop(): Promise<void> }

// ./run with `args` in a pseudo-terminal of its own; `screen` is the
// plain text written since the last `clear`.
function launch(home: string, args: string[] = []): Term {
	let buf = ''
	let dec = new TextDecoder()
	let term = new Bun.Terminal({
		cols: 160,
		rows: 45,
		data(_t, bytes) {
			buf += dec.decode(bytes, { stream: true })
			if (buf.length > 60000) buf = buf.slice(-60000)
		},
	})
	let root = realpathSync(`${home}/..`)
	let proc = Bun.spawn([run, ...args], { cwd: root, env: { ...process.env, HAL_HOME: home, TMPDIR: home, HAL_STALLS: `${root}/stalls.log` }, terminal: term, detached: true })
	return {
		exited: () => proc.exitCode !== null,
		write: (s) => term.write(s),
		screen: () => strip(buf),
		clear: () => (buf = ''),
		rss() {
			let pids = Bun.spawnSync(['pgrep', '-g', String(proc.pid)]).stdout.toString().trim().split('\n').filter(Boolean)
			if (!pids.length) return 0
			return Bun.spawnSync(['ps', '-o', 'rss=', '-p', pids.join(',')]).stdout.toString().trim().split('\n').reduce((a, b) => a + Number(b), 0) * 1024
		},
		async stop() {
			if (proc.exitCode !== null) return
			term.write('\x03')
			await Promise.race([proc.exited, Bun.sleep(5000)])
			try {
				process.kill(-proc.pid, 'SIGKILL')
			} catch {}
		},
	}
}

async function until(test: () => boolean, ms: number): Promise<number | undefined> {
	let t = performance.now()
	while (performance.now() - t < ms) {
		if (test()) return performance.now() - t
		await Bun.sleep(2)
	}
	return undefined
}

type Stalls = { n: number; max: number; total: number; worst: string }
type Probe = { first?: number; interactive?: number; p50?: number; p99?: number; max?: number; lost: number; allMarks?: number; rssMB: number; stalls: Stalls }

// Event-loop blocks over 10 ms that any Hal process under `root`
// reported (HAL_STALLS, task 7j) between wall-clock `from` and `to`;
// `worst` lists the longest as length@seconds-since-from.
function stalls(root: string, from: number, to: number): Stalls {
	let file = `${root}/stalls.log`
	let all = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ').map(Number) as [number, number, number]) : []
	let got = all.filter(([, at]) => at >= from && at <= to).map(([, at, ms]) => ({ at: (at - from) / 1000, ms }))
	let worst = got.toSorted((a, b) => b.ms - a.ms).slice(0, 4).map((s) => `${s.ms}@${s.at.toFixed(1)}s`).join(' ')
	return { n: got.length, max: Math.max(0, ...got.map((s) => s.ms)), total: got.reduce((a, s) => a + s.ms, 0), worst }
}

// Launches ./run, types a key at once (time to interactive), then one key
// at a time for `secs`, each erased once it shows.
async function probe(home: string, args: string[], ready: RegExp, secs: number, open: string[]): Promise<Probe> {
	let t0 = performance.now(), wall = Date.now()
	let term = launch(home, args)
	term.write('Ω')
	let first: number | undefined, interactive: number | undefined, allMarks: number | undefined
	let lat: number[] = []
	let lost = 0, rss = 0, i = 0
	await until(() => {
		let s = term.screen()
		if (first === undefined && ready.test(s)) first = performance.now() - t0
		// After a frame's rule: the tty echoes the key before raw mode.
		let bar = s.indexOf('─')
		if (interactive === undefined && bar >= 0 && s.includes('Ω', bar)) interactive = performance.now() - t0
		return first !== undefined && interactive !== undefined
	}, 10000)
	term.write('\x7f')
	let end = performance.now() + secs * 1000
	while (performance.now() < end) {
		if (term.exited()) throw new Error(`./run ${args.join(' ')} exited: ${term.screen().slice(-2000)}`)
		let ch = keys[i++ % keys.length]!
		term.clear()
		let at = performance.now()
		term.write(ch)
		let took = await until(() => term.screen().includes(ch), 3000)
		if (took === undefined) lost++
		else lat.push(took)
		term.write('\x7f')
		if (allMarks === undefined && open.length && open.every((id) => existsSync(`${home}/sessions/${id}/marks.ason`))) allMarks = performance.now() - t0
		if (i % 10 === 0) rss = Math.max(rss, term.rss())
		await Bun.sleep(Math.max(0, 100 - (performance.now() - at)))
	}
	let stalled = stalls(realpathSync(`${home}/..`), wall, Date.now())
	await term.stop()
	lat.sort((a, b) => a - b)
	return { first, interactive, p50: lat[lat.length >> 1], p99: lat[Math.floor(lat.length * 0.99)], max: lat.at(-1), lost, allMarks, rssMB: Math.round(rss / 2 ** 20), stalls: stalled }
}

// Ctrl-N through every tab on a running client; each switch's time until
// a key typed right after it shows.
async function switches(term: Term, n: number): Promise<number[]> {
	let out: number[] = []
	for (let i = 0; i < n; i++) {
		let ch = keys[i % keys.length]!
		term.clear()
		term.write('\x0e' + ch)
		let took = await until(() => term.screen().includes(ch), 5000)
		out.push(took ?? Infinity)
		term.write('\x7f')
		await Bun.sleep(150)
	}
	return out
}

async function freePort(): Promise<number> {
	for (let p = 9060; p <= 9100; p++) {
		try {
			Bun.serve({ hostname: '127.0.0.1', port: p, fetch: () => new Response() }).stop(true)
			return p
		} catch {}
	}
	throw new Error('no free port in 9060-9100')
}

function code(home: string): string {
	let out = Bun.spawnSync([run, 'auth'], { env: { ...process.env, HAL_HOME: home, TMPDIR: home } }).stdout.toString()
	let m = out.match(/\?auth=(\S+)/)
	if (!m) throw new Error(`./run auth said: ${out}`)
	return m[1]!
}

const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))

// Time from navigating to the page until the focused tab's history and
// prompt show, in headless Chrome.
async function webLoad(url: string): Promise<number | undefined> {
	if (!chrome) return undefined
	let dir = mkdtempSync(`${tmpdir()}/hal-perf-chrome-`)
	let proc = Bun.spawn([chrome, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdout: 'ignore', stderr: 'ignore' })
	try {
		let port = ''
		await until(() => existsSync(`${dir}/DevToolsActivePort`) && !!(port = readFileSync(`${dir}/DevToolsActivePort`, 'utf8').split('\n')[0]!), 10000)
		let targets: { type: string; webSocketDebuggerUrl: string }[] = []
		for (let i = 0; i < 100 && !targets.some((t) => t.type === 'page'); i++) {
			targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
			await Bun.sleep(20)
		}
		let ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
		await new Promise((r) => (ws.onopen = r))
		let next = 0
		let waiting = new Map<number, (m: { result?: { result?: { value?: unknown } } }) => void>()
		ws.onmessage = (m) => {
			let msg = JSON.parse(String(m.data))
			waiting.get(msg.id)?.(msg)
		}
		let call = (method: string, params: object) => new Promise<{ result?: { result?: { value?: unknown } } }>((resolve) => (waiting.set(++next, resolve), ws.send(JSON.stringify({ id: next, method, params }))))
		let t = performance.now()
		await call('Page.navigate', { url })
		let ready = false
		while (!ready && performance.now() - t < 20000) {
			ready = !!(await call('Runtime.evaluate', { expression: `!!document.querySelector('.entry .hint')?.textContent && document.querySelectorAll('.Transcript *').length > 50`, returnByValue: true })).result?.result?.value
			if (!ready) await Bun.sleep(5)
		}
		ws.close()
		return ready ? performance.now() - t : undefined
	} finally {
		proc.kill()
		await proc.exited
		rmSync(dir, { recursive: true, force: true })
	}
}

const ms = (x: number | undefined) => (x === undefined ? '—' : x === Infinity ? 'stuck' : `${Math.round(x)} ms`)

async function main(): Promise<number> {
	let scale = Number(process.argv[2] ?? 1)
	// Under /tmp: the host's socket path must stay under 104 bytes.
	let root = mkdtempSync('/tmp/hp-')
	let home = `${root}/h`
	let failed: string[] = []
	let check = (what: string, value: number | undefined, budget: number) => {
		if (value === undefined || value > budget) failed.push(`${what}: ${ms(value)} > ${budget} ms`)
	}
	try {
		let t = performance.now()
		let { open, sessions } = perfHome.generate(home, { scale, cwd: realpathSync(root) })
		let port = await freePort()
		writeFileSync(`${home}/config.ason`, `{ webPort: ${port} }\n`)
		console.log(`home: ${sessions} sessions, ${open.length} open tabs, generated in ${ms(performance.now() - t)} (scale ${scale})`)
		let rows: [string, Probe][] = []
		let hostReady = /\bhost\b/

		rows.push(['host, cold', await probe(home, [], hostReady, 15, open)])
		rows.push(['host, warm', await probe(home, [], hostReady, 10, [])])

		let host = launch(home)
		await until(() => hostReady.test(host.screen()), 10000)
		await Bun.sleep(3000)
		rows.push(['peer', await probe(home, [], /\bpeer\b/, 10, [])])

		let peer = launch(home)
		await until(() => /\bpeer\b/.test(peer.screen()), 10000)
		await Bun.sleep(3000)
		let swFrom = Date.now()
		let sw = await switches(peer, Math.min(open.length, 30))
		let swStalls = stalls(realpathSync(root), swFrom, Date.now())
		await peer.stop()

		let remote = `${root}/r`
		mkdirSync(remote)
		let login = launch(remote, ['-r', `localhost:${port}`])
		await until(() => /code/i.test(login.screen()), 10000)
		login.clear()
		login.write(code(home) + '\r')
		if ((await until(() => login.screen().includes(`localhost:${port}`), 10000)) === undefined) throw new Error(`-r login failed: ${login.screen().slice(-1000)}`)
		await login.stop()
		rows.push(['-r to this host', await probe(remote, ['-r'], new RegExp(`localhost:${port}`), 10, [])])

		let webFrom = Date.now()
		let web = await webLoad(`http://localhost:${port}/?auth=${code(home)}`)
		let webStalls = stalls(realpathSync(root), webFrom, Date.now())
		await host.stop()

		console.log('\nsetup             first screen  interactive  key p50  key p99  key max  lost  all indexed  memory')
		for (let [name, p] of rows) console.log(`${name.padEnd(18)}${ms(p.first).padStart(12)}${ms(p.interactive).padStart(13)}${ms(p.p50).padStart(9)}${ms(p.p99).padStart(9)}${ms(p.max).padStart(9)}${String(p.lost).padStart(6)}${ms(p.allMarks).padStart(13)}${`${p.rssMB} MB`.padStart(8)}`)
		let sorted = sw.toSorted((a, b) => a - b)
		console.log(`\ntab switch (${sw.length}, peer): p50 ${ms(sorted[sorted.length >> 1])}, max ${ms(sorted.at(-1))}`)
		console.log(`web page ready (focused tab shown): ${chrome ? ms(web) : 'no Chrome'}`)
		let stallRows: [string, Stalls][] = [...rows.map(([n, p]): [string, Stalls] => [n, p.stalls]), ['tab switching', swStalls], ['web page load (host)', webStalls]]
		console.log('\nevent-loop blocks over 10 ms (task 7j)\nsetup                 count  longest    total  worst (ms@s)')
		for (let [name, st] of stallRows) console.log(`${name.padEnd(20)}${String(st.n).padStart(7)}${ms(st.max).padStart(9)}${ms(st.total).padStart(9)}  ${st.worst}`)

		for (let [name, p] of rows) {
			if (name !== 'host, cold') {
				check(`${name} first screen`, p.first, 150)
				check(`${name} interactive`, p.interactive, 200)
			}
			check(`${name} key p99`, p.p99, 50)
			if (p.lost) failed.push(`${name}: ${p.lost} keys never showed`)
			if (p.rssMB > 1024) failed.push(`${name}: memory ${p.rssMB} MB > 1024 MB`)
		}
		for (let [name, st] of stallRows) if (st.max > 10) failed.push(`${name}: event loop blocked ${st.max} ms > 10 ms`)
		check('host, cold every tab indexed', rows[0]![1].allMarks, 10000)
		check('tab switch max', sorted.at(-1), 200)
		if (chrome) check('web page ready', web, 1000)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
	console.log(failed.length ? `\nover budget:\n  ${failed.join('\n  ')}` : '\nall within budget')
	return failed.length ? 1 : 0
}

if (import.meta.main) process.exit(await main())
