// The startup budget (task kn): ./run in a terminal draws the UI (tab
// bar, the prompt with its local draft, the focused tab's tail) within
// 150 ms and shows a key typed at once within 200 ms, as host and when
// joining a running host, with 50 open tabs and 20 MB histories.
//
// Machine assumption: a developer machine at least as fast as an Apple
// M1, not otherwise busy, with a warm file cache (a warm-up start runs
// first). Each figure is the fastest of several starts: other load only
// ever adds time, while work added to the startup path slows every
// start, the fastest too. On a slower machine, or one so busy that no
// start runs undisturbed, this test fails; that is its job. Change
// the budget only when the product requirement changes.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from './common/ason.ts'

const uiMs = 150
const typingMs = 200
const starts = 5
const tabCount = 50
const bigBytes = 20_000_000

// Skipped, saying why, where no pseudo-terminal can be made.
const noPty = (() => {
	if (typeof Bun.Terminal !== 'function') return 'Bun.Terminal is missing'
	try {
		new Bun.Terminal({}).close()
		return ''
	} catch (e: any) {
		return `no pseudo-terminal: ${e?.message ?? e}`
	}
})()
if (noPty) console.log(`startup budget test skipped: ${noPty}`)

let home = ''
let cwd = ''
const draft = 'DRAFTX'
const tail = 'TAIL-OF-FOCUSED'

// A session whose history is about `bytes` long: prompts, answers and
// turn ends, the last answer ending in `last`.
function session(n: number, bytes: number, last: string): string {
	let id = `${n}-abc`
	let dir = `${home}/sessions/${id}`
	let ts = new Date().toISOString()
	mkdirSync(dir, { recursive: true })
	writeFileSync(`${dir}/session.ason`, ason.stringify({ id, cwd: n === tabCount ? cwd : `${cwd}/other-${n}`, model: 'anthropic/claude-opus-4-5', createdAt: ts }) + '\n')
	let turn = (i: number, answer: string) =>
		ason.stringifyLine({ type: 'user', blocks: [{ type: 'text', text: `question ${i}: ${'why '.repeat(40)}` }], ts }) +
		ason.stringifyLine({ type: 'assistant', block: { type: 'text', text: answer }, ts }) +
		ason.stringifyLine({ type: 'turn_end', status: 'completed', usage: { input: 10, output: 10 }, ts })
	let one = turn(0, `answer: ${'lorem ipsum '.repeat(150)}`)
	let chunks = Array.from({ length: Math.max(1, Math.floor(bytes / one.length)) }, () => one)
	chunks.push(turn(1, `the end. ${last}`))
	writeFileSync(`${dir}/history.asonl`, chunks.join(''))
	return id
}

beforeAll(() => {
	if (noPty) return
	home = mkdtempSync(`${tmpdir()}/hal-startup-`)
	cwd = realpathSync(mkdtempSync(`${tmpdir()}/hal-startup-cwd-`))
	mkdirSync(`${home}/state/drafts`, { recursive: true, mode: 0o700 })
	let open: string[] = []
	// The focused tab (cwd's, the last) and one in the background are big.
	for (let n = 1; n <= tabCount; n++) open.push(session(n, n === 1 || n === tabCount ? bigBytes : 200_000, n === tabCount ? tail : `tail ${n}`))
	writeFileSync(`${home}/state/tabs.ason`, ason.stringify({ open, closed: [], attention: [] }) + '\n')
	writeFileSync(`${home}/state/drafts/${open.at(-1)}.ason`, ason.stringify({ text: draft, base: 0, dirty: true, sending: [] }) + '\n')
})

afterAll(() => {
	if (!home) return
	rmSync(home, { recursive: true, force: true })
	rmSync(cwd, { recursive: true, force: true })
})

type Run = { proc: Bun.Subprocess; term: Bun.Terminal; ui?: number; echo?: number }

// Every start types its own key, one found nowhere else on screen. The
// draft is kept, so it grows by a line of each earlier key.
const keys = 'αβγδεζηθικλμνξπρστυφχψω'
let started = 0

// Starts ./run in a pseudo-terminal and types one key at once. `ui`:
// ms until the output holds the tab bar, the tail and the draft; `echo`:
// until it shows the key after the draft.
function start(): Run {
	let key = keys[started++ % keys.length]!
	let t0 = Date.now()
	let run = {} as Run
	let seen = { bar: false, tail: false, draft: false }
	let rest = ''
	let decoder = new TextDecoder()
	run.term = new Bun.Terminal({
		cols: 120,
		rows: 40,
		data(_t, bytes) {
			// The host goes on to draw megabytes of history: scan only a
			// bounded window, and stop once both times are in, or this
			// process falls behind and holds up the one it measures.
			if (run.echo !== undefined && run.ui !== undefined) return
			let text = rest + decoder.decode(bytes, { stream: true })
			// Drop CSI and OSC (hyperlinks wrap tab numbers and blocks).
			let plain = text.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
			rest = text.slice(-10_000)
			let ms = Date.now() - t0
			// Tab numbers, each maybe with its state glyph (task fr).
			seen.bar ||= /\b1\S? +2\S? +3\S? +4\S? +5\b/.test(plain)
			seen.tail ||= plain.includes(tail)
			seen.draft ||= plain.includes(draft)
			if (run.ui === undefined && seen.bar && seen.tail && seen.draft) run.ui = ms
			// After the draft: the tty echoes the key itself before raw mode.
			let at = plain.lastIndexOf(draft)
			if (run.echo === undefined && at >= 0 && plain.includes(key, at)) run.echo = ms
		},
	})
	run.proc = Bun.spawn([`${import.meta.dir}/../run`], {
		cwd,
		// SIGKILL skips ./run's trap, so its tab file goes in the home.
		env: { ...process.env, HAL_HOME: home, HAL_STARTUP_TIMESTAMP: String(t0), TMPDIR: home },
		terminal: run.term,
		// Its own process group, so stop() takes ./run and its bun child.
		detached: true,
	})
	run.term.write(key)
	return run
}

async function stop(run: Run): Promise<void> {
	// The whole group: ./run and its bun child.
	try {
		process.kill(-run.proc.pid, 'SIGKILL')
	} catch {}
	await run.proc.exited
	run.term.close()
}

async function settle(run: Run): Promise<void> {
	let deadline = Date.now() + 2000
	while ((run.ui === undefined || run.echo === undefined) && Date.now() < deadline) await Bun.sleep(10)
}

// Fastest ui and echo times of `starts` starts, each stopped before the next.
async function measure(): Promise<{ ui: number; echo: number }> {
	let ui: number[] = []
	let echo: number[] = []
	for (let i = 0; i < starts; i++) {
		let run = start()
		await settle(run)
		await stop(run)
		ui.push(run.ui ?? Infinity)
		echo.push(run.echo ?? Infinity)
	}
	return { ui: Math.min(...ui), echo: Math.min(...echo) }
}

test.skipIf(!!noPty)(
	'./run draws the UI and echoes typing within budget, as host and joining one',
	async () => {
		let warm = start()
		await settle(warm)
		await stop(warm)
		let asHost = await measure()

		let host = start()
		await settle(host)
		let joining = await measure()
		await stop(host)

		console.log(`startup: host ui ${asHost.ui} ms, typing ${asHost.echo} ms; joining ui ${joining.ui} ms, typing ${joining.echo} ms`)
		expect(asHost.ui).toBeLessThanOrEqual(uiMs)
		expect(asHost.echo).toBeLessThanOrEqual(typingMs)
		expect(joining.ui).toBeLessThanOrEqual(uiMs)
		expect(joining.echo).toBeLessThanOrEqual(typingMs)
	},
	60_000,
)
