// Plugins (tasks an, 90v). Every test hooks objects from its own temp module,
// so nothing leaks into the real module singletons or other test files.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { plugins } from './plugins.ts'

let dir = ''
let reports: string[] = []
let t: any
let g = globalThis as any

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'hal-plugins-'))
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
	writeFileSync(path, `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\n${head}\nexport default (plugin: any) => {\n${body}\n}\n`)
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

test('set: the last file wins, removing it reveals the earlier one, then the original; a function target is refused', async () => {
	let a = await plugin('a.ts', `plugin.set(t, 'value', 4)`)
	let b = await plugin('b.ts', `plugin.set(t, 'value', 5)`)
	expect(t.value).toBe(5)
	plugins.remove(b)
	expect(t.value).toBe(4)
	plugins.remove(a)
	expect(t.value).toBe(3)
	await plugin('c.ts', `plugin.set(t, 'f', 1)`)
	expect(reports.join()).toContain('t.f')
	expect(typeof t.f).toBe('function')
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

test('hooks act as soon as registered; replacing a version removes its hooks and data before its cleanup, then runs the new body', async () => {
	let path = await plugin(
		'a.ts',
		`plugin.around(t, 'f', () => 'v1')
plugin.set(t, 'value', 4)
t.log.push('setup sees ' + t.f(1) + ' ' + t.value)
return () => t.log.push('cleanup sees ' + t.f(1) + ' ' + t.value)`,
		'globalThis.pluginRuns++',
	)
	expect(t.log).toEqual(['setup sees v1 4'])
	await plugin('a.ts', `t.log.push('v2 body sees ' + t.f(1) + ' ' + t.value)\nplugin.set(t, 'value', 5)`, 'globalThis.pluginRuns++')
	expect(g.pluginRuns).toBe(2)
	expect(t.log.filter((l: string) => l !== 'f')).toEqual(['setup sees v1 4', 'cleanup sees 2 3', 'v2 body sees 2 3'])
	expect(t.value).toBe(5)
	plugins.remove(path)
	expect(t.value).toBe(3)
})

test('a file that throws in its body runs without its hooks and is renamed to .ts.broken', async () => {
	let original = t.f
	let path = await plugin('a.ts', `plugin.around(t, 'f', () => 'v1')\nreturn () => t.log.push('v1 cleanup')`)
	writeFileSync(path, `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\nexport default (plugin: any) => { plugin.around(t, 'f', () => 'v2'); throw new Error('bad v2') }\n`)
	await plugins.load(path)
	expect(t.f).toBe(original)
	expect(t.log).toEqual(['v1 cleanup'])
	expect(existsSync(path)).toBe(false)
	expect(existsSync(`${path}.broken`)).toBe(true)
	expect(reports).toHaveLength(1)
	for (let part of [path, `${path}.broken`, 'bad v2']) expect(reports[0]).toContain(part)
	expect(plugins.describe()).toContain('bad v2')
	// Removing the vanished file keeps the error for /plugins.
	await plugins.sync(dir, 'a.ts')
	expect(plugins.describe()).toContain('bad v2')
})

test('an async registration function is refused, and hooks registered after the body returned are refused', async () => {
	let original = t.f
	let path = await plugin('a.ts', `globalThis.late = plugin`)
	expect(() => g.late.around(t, 'f', () => 0)).toThrow('after the registration function returned')
	expect(t.f).toBe(original)
	writeFileSync(path, `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\nexport default async (plugin: any) => { plugin.around(t, 'f', () => 0) }\n`)
	await plugins.load(path)
	expect(t.f).toBe(original)
	expect(reports[0]).toContain('a Promise')
	expect(existsSync(`${path}.broken`)).toBe(true)
})

test('deleting a file removes its hooks and runs its cleanup', async () => {
	let original = t.f
	let path = await plugin('a.ts', `plugin.around(t, 'f', () => 0)
return () => t.log.push('cleaned')`)
	unlinkSync(path)
	await plugins.sync(dir, 'a.ts')
	expect(t.f).toBe(original)
	expect(t.log).toEqual(['cleaned'])
})

test('an expired file never registers; a live one is unloaded when its expiry passes', async () => {
	let original = t.f
	await plugin('old.ts', `globalThis.pluginRuns++`, `export const expires = '2020-01-01T00:00:00Z'`)
	expect(g.pluginRuns).toBe(0)
	expect(t.f).toBe(original)
	let soon = new Date(Date.now() + 150).toISOString()
	await plugin('soon.ts', `plugin.around(t, 'f', () => 0)\nreturn () => t.log.push('expired')`, `export const expires = '${soon}'`)
	expect(t.f(1)).toBe(0)
	await Bun.sleep(300)
	expect(t.f).toBe(original)
	expect(t.log).toEqual(['expired'])
	expect(plugins.describe()).toContain(`expired ${soon}`)
})

test('a missing or non-function target, or a bad expires, breaks the file with an error naming file and target', async () => {
	let original = t.f
	let path = await plugin('a.ts', `plugin.around(t, 'f', () => 0)\nplugin.before(t, 'nope', () => {})`)
	expect(t.f).toBe(original)
	expect(reports[0]).toContain(path)
	expect(reports[0]).toContain('target.nope')
	await plugin('b.ts', `plugin.before(t, 'value', () => {})`)
	expect(reports[1]).toContain('target.value')
	// So is an expires that is not a UTC ISO time.
	await plugin('c.ts', `plugin.around(t, 'f', () => 0)`, `export const expires = 'tomorrow'`)
	expect(t.f).toBe(original)
	expect(reports[2]).toContain('expires')
})

test('the directory is watched: a new file hooks, an edit reloads, /plugins names the targets', async () => {
	// Its own directory: target.ts is no plugin.
	await plugins.init(join(dir, 'p'))
	let path = join(dir, 'p', 'w.ts')
	let head = `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\n`
	writeFileSync(path, `${head}export default (plugin: any) => plugin.around(t, 'f', () => 'one')\n`)
	for (let i = 0; i < 100 && t.f(1) !== 'one'; i++) await Bun.sleep(20)
	expect(t.f(1)).toBe('one')
	expect(plugins.describe()).toContain('target.f around')
	writeFileSync(path, `${head}export default (plugin: any) => plugin.around(t, 'f', () => 'two')\n`)
	for (let i = 0; i < 100 && t.f(1) !== 'two'; i++) await Bun.sleep(20)
	expect(t.f(1)).toBe('two')
})

test('/plugins disable and enable toggle a watched plugin and restore its file exactly', async () => {
	let d = join(dir, 'p')
	let realDir = plugins.dir
	plugins.dir = () => d
	try {
		await plugins.init(d)
		let { command } = await import('./commands/plugins.ts')
		let path = join(d, 'w.ts')
		let text = `import { t } from ${JSON.stringify(join(dir, 'target.ts'))}\nexport default function (p: any) {\n\tp.around(t, 'f', () => 'on')\n}\n`
		writeFileSync(path, text)
		for (let i = 0; i < 100 && t.f(1) !== 'on'; i++) await Bun.sleep(20)
		expect(await command.run('disable w', undefined, {} as any)).toEqual({ say: 'w.ts: disabled' })
		expect(t.f(1)).toBe(2)
		expect(await command.run('enable w.ts', undefined, {} as any)).toEqual({ say: 'w.ts: loaded' })
		expect(t.f(1)).toBe('on')
		expect(readFileSync(path, 'utf8')).toBe(text)
	} finally {
		plugins.dir = realDir
	}
})

test('disable stops the body, removes what it registered, and is not a failure', async () => {
	let original = t.f
	let path = await plugin('a.ts', `plugin.around(t, 'f', (fn: any, x: number) => fn(x) + 1)\nplugin.disable()\nglobalThis.pluginRuns++\nreturn () => globalThis.pluginRuns++`)
	expect(t.f).toBe(original)
	expect(g.pluginRuns).toBe(0)
	expect(reports).toEqual([])
	expect(existsSync(path)).toBe(true)
	expect(plugins.describe()).toContain('disabled')
	plugins.remove(path)
	expect(g.pluginRuns).toBe(0)
})
