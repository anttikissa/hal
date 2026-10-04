import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { cost } from './cost.ts'
import { models } from './models.ts'
import { modelsDev } from './models-dev.ts'
import { paths } from './paths.ts'

let home = ''
const savedHome = process.env.HAL_HOME
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-cost-`)
	process.env.HAL_HOME = home
	paths.init()
})
afterEach(() => {
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	modelsDev.state.catalog = null
	rmSync(home, { recursive: true, force: true })
})

const ts = '2026-10-04T08:00:00Z'
function session(id: string, records: HistoryRecord[]) {
	mkdirSync(paths.sessionDir(id))
	writeFileSync(`${paths.sessionDir(id)}/session.ason`, ason.stringify({ id, cwd: '/example', model: 'anthropic/claude-opus-5-5', createdAt: ts }))
	writeFileSync(`${paths.sessionDir(id)}/history.asonl`, records.map((r) => ason.stringify(r, 'short')).join('\n') + '\n')
}

test('round usage wins over aggregate ends; resumed pauses, model switches and legacy ends are counted once', () => {
	let usage = { input: 1000, output: 100, cacheRead: 2000, cacheWrite: 300 }
	session('01-abc', [
		{ type: 'round', model: 'anthropic/claude-opus-5-5', usage, ts },
		{ type: 'turn_end', status: 'paused', usage, ts },
		{ type: 'continue', ts },
		{ type: 'change', model: 'unknown/model', ts },
		{ type: 'round', model: 'unknown/model', usage: { input: 42 }, ts },
		{ type: 'turn_end', status: 'completed', usage: { input: 42 }, ts },
	])
	session('01-def', [
		{ type: 'assistant', block: { type: 'text', text: 'legacy' }, model: 'anthropic/claude-opus-5-5', ts },
		{ type: 'turn_end', status: 'paused', usage: { input: 100 }, ts },
		{ type: 'continue', ts },
		{ type: 'turn_end', status: 'completed', usage: { input: 200 }, ts: '2026-10-04T09:00:00Z' },
	])
	let totals = cost.totals(['01-abc', '01-def'])
	expect(totals[0]!.usage).toEqual(usage)
	expect(totals[0]!.cost).toBeCloseTo(.0079)
	expect(totals[1]!.unpriced).toBe(1)
	expect(totals[2]!.usage.input).toBe(300)
	let filtered = cost.run(['--since', '2026-10-04T08:30:00Z'])
	expect(filtered).toContain('TOTAL  $0.0008')
	expect(filtered).not.toContain('01-abc')
	let report = cost.run([])
	expect(report).toContain('unknown/model')
	expect(report).toContain('PROVIDER anthropic  $0.0091')
	expect(report).toContain('total incomplete')
	let cli = Bun.spawnSync([process.execPath, `${paths.repoRoot()}/scripts/cost`, '01-abc'], { env: { ...process.env, HAL_HOME: home } })
	expect(cli.exitCode).toBe(0)
	expect(cli.stdout.toString()).toContain('TOTAL  $0.0079 + UNPRICED')
})

test('catalog retains prices, including cache prices; missing used-token prices are explicitly unpriced', () => {
	let catalog = modelsDev.parse({ fake: { models: { a: { cost: { input: 2, output: 8, cache_read: .1, cache_write: 3 } }, b: { cost: { input: 1, output: 2 } } } } })
	writeFileSync(modelsDev.file(), JSON.stringify(catalog))
	expect(models.pricing('fake/a')).toEqual({ input: 2, output: 8, cacheRead: .1, cacheWrite: 3 })
	session('01-abc', [{ type: 'round', model: 'fake/a', usage: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, ts }])
	session('01-def', [{ type: 'round', model: 'fake/b', usage: { cacheRead: 1 }, ts }])
	expect(cost.totals(['01-abc'])[0]!.cost).toBe(13.1)
	expect(cost.run(['01-def'])).toContain('UNPRICED')
	expect(() => modelsDev.parse({ fake: { models: { a: { cost: { input: -1, output: 2 } } } } })).toThrow('invalid cost')
	expect(() => cost.run(['--since', 'nonsense'])).toThrow('--since')
	expect(() => cost.run(['--wrong'])).toThrow('unknown option')
})
