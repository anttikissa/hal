// Headless Chrome for the web browser tests: a machine-wide slot limit,
// a watchdog that never lets Chrome outlive the test process, and one
// shared page per test file.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir, totalmem } from 'os'
import { until } from './web-fixture.test.ts'

const chrome = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/usr/bin/google-chrome',
].find((p) => existsSync(p))

// Test Chromes allowed at once on this machine, across all test runs:
// one per 4 GiB of RAM. A headless Chrome takes ~0.5 GB, and parallel
// agents' runs once filled a 7.6 GB server until the kernel OOM-killed.
const chromeSlots = Math.max(1, Math.floor(totalmem() / 2 ** 32))

// Takes a free slot directory, waiting while every slot is busy. A slot
// whose watchdog is gone (killed with SIGKILL, or a reboot) is stale.
async function slot(): Promise<string> {
	let deadline = Date.now() + 5 * 60_000
	for (;;) {
		let held: string[] = []
		for (let n = 0; n < chromeSlots; n++) {
			let dir = `${tmpdir()}/hal-chrome-${n}`
			try {
				mkdirSync(dir)
				return dir
			} catch {}
			let pid = Number(existsSync(`${dir}/watchdog.pid`) ? readFileSync(`${dir}/watchdog.pid`, 'utf8') : 0)
			let alive =
				pid > 0 &&
				(() => {
					try {
						return process.kill(pid, 0)
					} catch {
						return false
					}
				})()
			// A slot without a pid file is being taken right now, unless old.
			if (alive || (!pid && Date.now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 30_000))
				held.push(`${dir} (watchdog ${pid || 'starting'})`)
			else rmSync(dir, { recursive: true, force: true })
		}
		if (held.length === chromeSlots && Date.now() > deadline)
			throw new Error(`every test Chrome slot stayed busy for 5 minutes: ${held.join(', ')}`)
		await Bun.sleep(250)
	}
}

// Chrome runs under a detached sh watchdog, in its own process group.
// The watchdog kills that group and frees the slot when this test
// process dies in any way (SIGKILL, a signal to its pid alone, exit
// without afterAll: each left a whole Chrome behind before), when
// Chrome exits, or when close() sends it SIGTERM.
const watchdog = `owner=$1 dir=$2; shift 2
set -m
"$@" </dev/null >/dev/null 2>&1 & c=$!
stop() { kill -9 -- -$c 2>/dev/null; wait $c; rm -rf "$dir"; exit 0; }
trap stop TERM INT HUP
while kill -0 "$owner" 2>/dev/null && kill -0 $c 2>/dev/null; do sleep 1; done
stop`

// A headless Chrome page driven over the DevTools protocol.
async function launch() {
	let dir = await slot()
	let profile = `${dir}/profile`
	let proc = Bun.spawn(
		[
			'sh',
			'-c',
			watchdog,
			'sh',
			String(process.pid),
			dir,
			chrome!,
			'--headless=new',
			'--remote-debugging-port=0',
			`--user-data-dir=${profile}`,
			'--no-first-run',
			...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
			'about:blank',
		],
		{
			stdio: ['ignore', 'ignore', 'ignore'],
			detached: true,
		},
	)
	writeFileSync(`${dir}/watchdog.pid`, String(proc.pid))
	let port = ''
	await until(
		() =>
			existsSync(`${profile}/DevToolsActivePort`) &&
			(port = readFileSync(`${profile}/DevToolsActivePort`, 'utf8').split('\n')[0]!),
	)
	let targets: any[] = []
	for (let i = 0; i < 100 && !targets.some((t) => t.type === 'page'); i++) {
		targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
		await Bun.sleep(20)
	}
	let ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
	await new Promise((r) => (ws.onopen = r))
	let next = 0
	let waiting = new Map<number, (m: any) => void>()
	// Solid dev diagnostics ("[STRICT_READ_UNTRACKED] …") the page logged.
	let diagnostics: string[] = []
	ws.onmessage = (m) => {
		let msg = JSON.parse(String(m.data))
		waiting.get(msg.id)?.(msg)
		if (msg.method === 'Runtime.exceptionThrown')
			diagnostics.push(
				`[EXCEPTION] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`,
			)
		if (msg.method !== 'Runtime.consoleAPICalled') return
		let text = msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')
		if (/^\[[A-Z][A-Z_]+\]/.test(text)) diagnostics.push(text)
	}
	let call = (method: string, params: object) =>
		new Promise<any>((resolve) => {
			waiting.set(++next, resolve)
			ws.send(JSON.stringify({ id: next, method, params }))
		})
	let evaluate = async (expression: string) => {
		let response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
		if (response.result?.exceptionDetails)
			throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text)
		return response.result?.result?.value
	}
	let waitFor = async (expression: string) => {
		for (let i = 0; i < 250; i++) {
			if (await evaluate(expression)) return
			await Bun.sleep(20)
		}
		throw new Error(
			`timed out waiting for ${expression}: ${await evaluate('location.href + document.documentElement.outerHTML.slice(-600)')}`,
		)
	}
	await call('Runtime.enable', {})
	let close = async () => {
		ws.close()
		proc.kill()
		await proc.exited
	}
	return { call, evaluate, waitFor, close, diagnostics }
}

// One Chrome for the file (a launch costs ~0.4 s). Closing a test's
// browser hands the page back blank: no cookies, storage or forced size.
let shared: ReturnType<typeof launch> | undefined
export async function browser() {
	let b = await (shared ??= launch())
	let close = async () => {
		await b.evaluate('localStorage.clear()')
		await b.call('Network.clearBrowserCookies', {})
		await b.call('Emulation.clearDeviceMetricsOverride', {})
		await b.call('Page.navigate', { url: 'about:blank' })
		// The page logs no Solid reactivity diagnostics (task f09).
		expect(b.diagnostics.splice(0)).toEqual([])
	}
	return { ...b, close }
}
// A test that needs Chrome. Its own describe gives it a beforeAll that
// runs only when the test does (not under a -t filter that skips it), so
// waiting for a free slot never counts against the test's own timeout.
export function browserTest(name: string, fn: () => Promise<void>, timeout?: number): void {
	describe.skipIf(!chrome)('browser', () => {
		beforeAll(async () => void (await (shared ??= launch())), 6 * 60_000)
		test(name, fn, timeout)
	})
}

// Registers the hook that closes the shared Chrome after the file.
export function useChrome(): void {
	afterAll(async () => {
		if (shared) await (await shared).close()
		shared = undefined
	})
}
