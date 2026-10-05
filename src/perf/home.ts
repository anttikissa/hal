// A generated Hal home for performance runs (task y9): a heavy user's
// shape, filler text, no real data. The same seed and scale give
// byte-identical files. CLI: bun src/perf/home.ts <home> [scale] [seed].
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'

// Open tabs by history size, then the closed sessions. Picked by hand to
// resemble a heavy user: a few tabs of tens of MB, many small ones.
const shape = {
	open: [
		{ count: 1, bytes: 50e6 },
		{ count: 2, bytes: 20e6 },
		{ count: 5, bytes: 5e6 },
		{ count: 12, bytes: 1e6 },
		{ count: 40, bytes: 200e3 },
	],
	closed: { count: 2000, bytes: 20e3 },
}

const words = 'the a of to and in is it that for on with as this be are from by at or not an file host tab session test client state draft frame render model tool result line page key time error value task code change read write build open close run'.split(' ')
const tools = ['bash', 'read', 'grep', 'edit', 'glob']

// mulberry32: small, fast, deterministic.
function rng(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type Rand = () => number

const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
const pick = <T>(r: Rand, xs: T[]): T => xs[Math.floor(r() * xs.length)]!

function sentence(r: Rand): string {
	let n = int(r, 5, 18)
	let out: string[] = []
	for (let i = 0; i < n; i++) out.push(pick(r, words))
	let s = out.join(' ')
	return s[0]!.toUpperCase() + s.slice(1) + '.'
}

function paragraph(r: Rand, sentences: number): string {
	return Array.from({ length: sentences }, () => sentence(r)).join(' ')
}

function codeLine(r: Rand): string {
	let indent = '\t'.repeat(int(r, 0, 3))
	return `${indent}let ${pick(r, words)}${int(r, 0, 99)} = ${pick(r, words)}.${pick(r, words)}(${int(r, 0, 999)})`
}

// Markdown the model writes: paragraphs, a list, sometimes code or a table.
function reply(r: Rand): string {
	let parts = [paragraph(r, int(r, 1, 4))]
	if (r() < 0.4) parts.push(Array.from({ length: int(r, 2, 6) }, () => `- ${sentence(r)}`).join('\n'))
	if (r() < 0.3) parts.push('```ts\n' + Array.from({ length: int(r, 3, 25) }, () => codeLine(r)).join('\n') + '\n```')
	if (r() < 0.1) parts.push('| a | b |\n|---|---|\n' + Array.from({ length: int(r, 2, 8) }, () => `| ${pick(r, words)} | ${int(r, 0, 9999)} |`).join('\n'))
	return parts.join('\n\n')
}

// Tool output: mostly short, sometimes huge; a few with very long lines,
// ANSI colour or wide characters, as real command output has.
function output(r: Rand): string {
	let x = r()
	let count = x < 0.7 ? int(r, 1, 40) : x < 0.95 ? int(r, 40, 400) : int(r, 400, 6000)
	let kind = r()
	let out: string[] = []
	for (let i = 0; i < count; i++) {
		if (kind < 0.03) out.push(Array.from({ length: int(r, 30, 300) }, () => pick(r, words)).join(''))
		else if (kind < 0.08) out.push(`\x1b[3${int(r, 1, 6)}m${pick(r, words)}\x1b[0m ${sentence(r)}`)
		else if (kind < 0.1) out.push(`${sentence(r)} 漢字テスト 🙂`)
		else if (kind < 0.5) out.push(codeLine(r))
		else out.push(`src/${pick(r, words)}/${pick(r, words)}.ts:${int(r, 1, 999)}: ${sentence(r)}`)
	}
	return out.join('\n')
}

// One turn's records: prompt, then rounds of thinking, text and tools.
function turn(r: Rand, calls: { n: number }): object[] {
	let recs: object[] = [{ type: 'user', blocks: [{ type: 'text', text: paragraph(r, int(r, 1, 5)) }] }]
	let model = 'anthropic/claude-opus-5-5'
	let rounds = int(r, 1, 8)
	for (let i = 0; i < rounds; i++) {
		recs.push({ type: 'assistant', block: { type: 'thinking', text: paragraph(r, int(r, 1, 12)), signature: 'sig', provider: 'anthropic' }, model })
		if (r() < 0.5) recs.push({ type: 'assistant', block: { type: 'text', text: reply(r) }, model })
		if (i === rounds - 1) break
		let ids = Array.from({ length: int(r, 1, 3) }, () => `call_${++calls.n}`)
		for (let id of ids) {
			let name = pick(r, tools)
			recs.push({ type: 'assistant', block: { type: 'tool_call', id, name, input: name === 'bash' ? { command: `${pick(r, words)} ${pick(r, words)} | head` } : { path: `src/${pick(r, words)}.ts` } }, model })
		}
		recs.push({ type: 'user', blocks: ids.map((id) => ({ type: 'tool_result', id, output: output(r), ...(r() < 0.05 ? { isError: true } : {}) })) })
	}
	recs.push({ type: 'assistant', block: { type: 'text', text: reply(r) }, model })
	recs.push({ type: 'turn_end', status: 'completed', usage: { input: int(r, 1000, 200000), output: int(r, 100, 8000) } })
	return recs
}

// Writes one session of about `bytes`, ending idle.
function session(dir: string, id: string, bytes: number, r: Rand, cwd: string): void {
	mkdirSync(dir, { recursive: true })
	let createdAt = new Date(Date.UTC(2026, 0, 1) + int(r, 0, 200) * 86400e3).toISOString()
	writeFileSync(`${dir}/session.ason`, ason.stringify({ id, cwd, model: 'anthropic/claude-opus-5-5', name: sentence(r).slice(0, 40), createdAt }) + '\n')
	let path = `${dir}/history.asonl`
	writeFileSync(path, '')
	let n = 0, size = 0, chunk: string[] = [], chunkSize = 0
	let ms = Date.parse(createdAt)
	let calls = { n: 0 }
	while (size < bytes) {
		for (let rec of turn(r, calls)) {
			ms += int(r, 500, 60000)
			let line = lines.encode({ ...rec, n: ++n, ts: new Date(ms).toISOString() })
			size += line.length
			chunk.push(line)
			chunkSize += line.length
		}
		if (chunkSize > 1 << 22) {
			appendFileSync(path, chunk.join(''))
			chunk = []
			chunkSize = 0
		}
	}
	appendFileSync(path, chunk.join(''))
}

// Generates the home; `scale` shrinks counts and sizes for quick runs.
function generate(home: string, opts: { scale?: number; seed?: number; cwd?: string } = {}): { open: string[]; sessions: number } {
	let scale = opts.scale ?? 1
	let r = rng(opts.seed ?? 1)
	let cwd = opts.cwd ?? home
	let dir = `${home}/sessions`
	if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already has sessions`)
	let open: string[] = []
	let n = 0
	let id = () => `${++n}-${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + ((n * 7) % 26))}${String.fromCharCode(97 + ((n * 13) % 26))}`
	let closed = Math.max(1, Math.round(shape.closed.count * scale))
	for (let i = 0; i < closed; i++) {
		let s = id()
		session(`${dir}/${s}`, s, shape.closed.bytes * scale, r, cwd)
	}
	for (let g of shape.open) {
		for (let i = 0; i < Math.max(1, Math.round(g.count * scale)); i++) {
			let s = id()
			session(`${dir}/${s}`, s, g.bytes * scale, r, cwd)
			open.push(s)
		}
	}
	// Big tabs are spread among small ones, as the user opens them; the
	// biggest comes first, so a client starting in its cwd focuses it.
	let order = [...open]
	for (let i = order.length - 1; i > 1; i--) {
		let j = int(r, 1, i)
		;[order[i], order[j]] = [order[j]!, order[i]!]
	}
	mkdirSync(`${home}/state`, { recursive: true })
	writeFileSync(`${home}/state/tabs.ason`, ason.stringify({ open: order, closed: [], attention: [] }) + '\n')
	return { open: order, sessions: n }
}

export const perfHome = { generate, shape }

if (import.meta.main) {
	let [home, scale, seed] = process.argv.slice(2)
	if (!home) {
		console.error('usage: bun src/perf/home.ts <home> [scale] [seed]')
		process.exit(2)
	}
	let t = performance.now()
	let out = perfHome.generate(home, { scale: scale ? Number(scale) : 1, seed: seed ? Number(seed) : 1 })
	console.log(`${out.sessions} sessions, ${out.open.length} open, ${Math.round(performance.now() - t)} ms`)
}
