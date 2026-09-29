// Plugins (task an). Every test hooks objects from its own temp module,
// so nothing leaks into the real module singletons or other test files.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { plugins } from './plugins.ts'

let dir = ''
let reports: string[] = []
let t: any
let g = globalThis as any

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'hal2-plugins-'))
	reports = []
	plugins.report = (text) => void reports.push(text)
	writeFileSync(
		join(dir, 'target.ts'),
		`export const t = {
	n: 2,
	log: [] as string[],
	f(x: number) { this.log.push('f'); return x * this.n },
	async g(x: number) { await Bun.sleep(1); return x + 1 },
	boom() { throw new Error('boom') },
	value: 3,
}\n`,
	)
	t = (await import(join(dir, 'target.ts'))).t
	g.pluginRuns = 0
})

afterEach(() => {
	plugins.close()
	rmSync(dir, { recursive: true, force: true })
})

// Writes plugin `name` whose registration body is `body` (with `t` and
// `plugin` in scope) and loads it.
async function plugin(name: string, body: string, head = ''): Promise<string> {
	let path = join(dir, name)
	writeFileSync(path, `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\n${head}\nexport default async (plugin: any) => {\n${body}\n}\n`)
	await plugins.load(path)
	return path
}

test('removing each owner leaves the others, and the last puts the original back exactly', async () => {
	let original = t.f
	let a = await plugin('a.ts', `plugin.around(t, 'f', (fn: any, x: number) => fn(x) + 1)`)
	let b = await plugin('b.ts', `plugin.around(t, 'f', (fn: any, x: number) => fn(x) * 10)`)
	expect(t.f(1)).toBe(21)
	plugins.remove(a)
	expect(t.f(1)).toBe(20)
	plugins.remove(b)
	expect(t.f).toBe(original)
	expect(t.f(1)).toBe(2)
})

test('befores, then arounds with the first registered outermost, then afters; file order survives a reload', async () => {
	let a = await plugin('a.ts', `plugin.before(t, 'f', () => t.log.push('a-before'))
plugin.around(t, 'f', (fn: any, x: number) => { t.log.push('a-around'); return fn(x) })
plugin.after(t, 'f', () => t.log.push('a-after'))`)
	await plugin('b.ts', `plugin.before(t, 'f', () => t.log.push('b-before'))
plugin.around(t, 'f', (fn: any, x: number) => { t.log.push('b-around'); return fn(x) })
plugin.after(t, 'f', () => t.log.push('b-after'))`)
	t.f(1)
	expect(t.log).toEqual(['a-before', 'b-before', 'a-around', 'b-around', 'f', 'a-after', 'b-after'])
	// Reloading a.ts (now last to load) must not move it behind b.ts.
	writeFileSync(a, `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\nexport default (plugin: any) => plugin.before(t, 'f', () => t.log.push('a2'))\n`)
	await plugins.load(a)
	t.log.length = 0
	t.f(1)
	expect(t.log).toEqual(['a2', 'b-before', 'b-around', 'f', 'b-after'])
})

test('a hooked sync function stays sync and keeps this; errors pass through', async () => {
	await plugin('a.ts', `plugin.before(t, 'f', () => {})
plugin.after(t, 'boom', () => {})`)
	let other = { n: 5, log: [], f: t.f }
	expect(other.f(2)).toBe(10)
	expect(t.f(2)).toBe(4)
	expect(() => t.boom()).toThrow('boom')
})

test('async targets: an async around awaits fn, after sees the Promise as returned', async () => {
	await plugin('a.ts', `plugin.around(t, 'g', async (fn: any, x: number) => (await fn(x)) * 100)
plugin.after(t, 'g', (result: any) => { t.log.push(result instanceof Promise ? 'promise' : 'value') })`)
	expect(await t.g(1)).toBe(200)
	expect(t.log).toEqual(['promise'])
})

test('a rejected async before is reported, not awaited and not thrown', async () => {
	await plugin('a.ts', `plugin.before(t, 'f', async () => { await Bun.sleep(1); throw new Error('late') })`)
	expect(t.f(1)).toBe(2)
	await Bun.sleep(20)
	expect(reports.join()).toContain('late')
})

test('each reload re-runs the file; a failed reload keeps the old hooks and names the path', async () => {
	let path = await plugin('a.ts', `plugin.around(t, 'f', () => 'v1')`, 'globalThis.pluginRuns++')
	writeFileSync(path, `globalThis.pluginRuns++\nexport default (plugin: any) => { throw new Error('bad v2') }\n`)
	await plugins.load(path)
	expect(g.pluginRuns).toBe(2)
	expect(t.f(1)).toBe('v1')
	expect(reports).toHaveLength(1)
	expect(reports[0]).toContain(path)
	expect(reports[0]).toContain('bad v2')
	expect(plugins.describe()).toContain('bad v2')
})

test('deleting a file removes its hooks and runs its unload', async () => {
	let original = t.f
	let path = await plugin('a.ts', `plugin.around(t, 'f', () => 0)
plugin.unload(() => t.log.push('unloaded'))`)
	unlinkSync(path)
	await plugins.sync(dir, 'a.ts')
	expect(t.f).toBe(original)
	expect(t.log).toEqual(['unloaded'])
})

test('an expired file never registers; a live one is unloaded when its expiry passes', async () => {
	let original = t.f
	await plugin('old.ts', `globalThis.pluginRuns++`, `export const expires = '2020-01-01T00:00:00Z'`)
	expect(g.pluginRuns).toBe(0)
	expect(t.f).toBe(original)
	let soon = new Date(Date.now() + 150).toISOString()
	await plugin('soon.ts', `plugin.around(t, 'f', () => 0)\nplugin.unload(() => t.log.push('expired'))`, `export const expires = '${soon}'`)
	expect(t.f(1)).toBe(0)
	await Bun.sleep(300)
	expect(t.f).toBe(original)
	expect(t.log).toEqual(['expired'])
	expect(plugins.describe()).toContain(`expired ${soon}`)
})

test('expires that is not a UTC ISO time is a load error', async () => {
	await plugin('a.ts', `plugin.around(t, 'f', () => 0)`, `export const expires = 'tomorrow'`)
	expect(t.f(1)).toBe(2)
	expect(reports[0]).toContain('expires')
})

test('a missing or non-function target is a load error naming file and target, and registers nothing', async () => {
	let original = t.f
	let path = await plugin('a.ts', `plugin.around(t, 'f', () => 0)\nplugin.before(t, 'nope', () => {})`)
	expect(t.f).toBe(original)
	expect(reports[0]).toContain(path)
	expect(reports[0]).toContain('target.nope')
	await plugin('b.ts', `plugin.before(t, 'value', () => {})`)
	expect(reports[1]).toContain('target.value')
})

test('async registration stays staged; a load overtaken by an edit or deletion is discarded', async () => {
	let original = t.f
	let slow = `plugin.around(t, 'f', () => 'slow')\nawait new Promise((r) => (globalThis.release = r))`
	let path = join(dir, 'a.ts')
	writeFileSync(path, `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\nexport default async (plugin: any) => {\n${slow}\n}\n`)
	let pending = plugins.load(path)
	await Bun.sleep(20)
	expect(t.f).toBe(original)
	await plugin('a.ts', `plugin.around(t, 'f', () => 'fast')`)
	g.release()
	await pending
	expect(t.f(1)).toBe('fast')

	writeFileSync(path, `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\nexport default async (plugin: any) => {\n${slow}\n}\n`)
	pending = plugins.load(path)
	await Bun.sleep(20)
	unlinkSync(path)
	await plugins.sync(dir, 'a.ts')
	g.release()
	await pending
	expect(t.f).toBe(original)
})

test('the directory is watched: a new file hooks, an edit reloads, /plugins names the targets', async () => {
	await plugins.init(dir)
	let path = join(dir, 'w.ts')
	let head = `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\n`
	writeFileSync(path, `${head}export default (plugin: any) => plugin.around(t, 'f', () => 'one')\n`)
	for (let i = 0; i < 100 && t.f(1) !== 'one'; i++) await Bun.sleep(20)
	expect(t.f(1)).toBe('one')
	expect(plugins.describe()).toContain('target.f around')
	writeFileSync(path, `${head}export default (plugin: any) => plugin.around(t, 'f', () => 'two')\n`)
	for (let i = 0; i < 100 && t.f(1) !== 'two'; i++) await Bun.sleep(20)
	expect(t.f(1)).toBe('two')
})
