import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { perfHome } from './home.ts'

// Each generated home is megabytes: removed after every test.
let homes: string[] = []
const temp = (prefix: string): string => (homes.push(mkdtempSync(`${tmpdir()}/${prefix}`)), homes.at(-1)!)
afterEach(() => homes.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const small = { scale: 0.01, seed: 7 }

function files(home: string): Map<string, string> {
	let out = new Map<string, string>()
	let walk = (d: string) => {
		for (let e of readdirSync(d, { withFileTypes: true })) {
			if (e.isDirectory()) walk(`${d}/${e.name}`)
			else out.set(`${d}/${e.name}`.slice(home.length), readFileSync(`${d}/${e.name}`, 'utf8'))
		}
	}
	walk(home)
	return out
}

test('the same seed and scale give byte-identical homes; another seed differs', () => {
	let a = temp('perf-a-'), b = temp('perf-b-'), c = temp('perf-c-')
	perfHome.generate(a, { ...small, cwd: '/w' })
	perfHome.generate(b, { ...small, cwd: '/w' })
	perfHome.generate(c, { ...small, seed: 8, cwd: '/w' })
	expect(files(a)).toEqual(files(b))
	expect(files(a)).not.toEqual(files(c))
})

test('generated histories are valid, idle and sized as the shape says', () => {
	let home = temp('perf-')
	let { open, sessions } = perfHome.generate(home, small)
	let tabs = ason.parse(readFileSync(`${home}/state/tabs.ason`, 'utf8')) as { open: string[] }
	expect(tabs.open.toSorted()).toEqual(open.toSorted())
	expect(readdirSync(`${home}/sessions`)).toHaveLength(sessions)
	let sizes = open.map((id) => statSync(`${home}/sessions/${id}/history.asonl`).size).sort((x, y) => y - x)
	expect(sizes[0]).toBeGreaterThanOrEqual(perfHome.shape.open[0]!.bytes * small.scale)
	// A tab of the biggest size is first: a client starting in its cwd shows it.
	expect(statSync(`${home}/sessions/${tabs.open[0]}/history.asonl`).size).toBeGreaterThanOrEqual(perfHome.shape.open[0]!.bytes * small.scale)
	for (let id of readdirSync(`${home}/sessions`)) {
		let meta = ason.parse(readFileSync(`${home}/sessions/${id}/session.ason`, 'utf8')) as { id: string }
		expect(meta.id).toBe(id)
		let recs = readFileSync(`${home}/sessions/${id}/history.asonl`, 'utf8').split('\n').filter(Boolean).map((l) => ason.parse(l) as HistoryRecord)
		expect(recs.map((r) => r.n)).toEqual(recs.map((_, i) => i + 1))
		expect(recs.at(-1)?.type).toBe('turn_end')
		// Every tool call has its result, so replay sends the model no gaps.
		let calls = recs.flatMap((r) => (r.type === 'assistant' && r.block.type === 'tool_call' ? [r.block.id] : []))
		let results = recs.flatMap((r) => (r.type === 'user' ? r.blocks.flatMap((b) => (b.type === 'tool_result' ? [b.id] : [])) : []))
		expect(results).toEqual(calls)
		let outputs = replay.toMessages(recs).flatMap((m) => m.blocks.flatMap((b) => (b.type === 'tool_result' ? [b.output] : [])))
		expect(outputs.some((o) => o === replay.missingResult('completed') || o === replay.missingResult('paused'))).toBe(false)
	}
})
