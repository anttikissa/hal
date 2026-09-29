import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { liveFiles } from './live-file.ts'

let dir = ''
let errors: Error[] = []
const origOnError = liveFiles.onError
const open: object[] = []

function live<T extends Record<string, any>>(path: string, defaults: T, opts?: Parameters<typeof liveFiles.liveFile>[2]): T {
	let data = liveFiles.liveFile(path, defaults, opts)
	open.push(data)
	return data
}

beforeEach(() => {
	dir = mkdtempSync(`${tmpdir()}/hal-livefile-`)
	errors = []
	liveFiles.onError = (error) => errors.push(error)
})

afterEach(() => {
	for (let data of open.splice(0)) {
		try {
			liveFiles.close(data)
		} catch {}
	}
	liveFiles.onError = origOnError
	rmSync(dir, { recursive: true, force: true })
})

function disk(path: string): any {
	return ason.parse(readFileSync(path, 'utf8'))
}

const tick = () => Bun.sleep(0)

async function until(check: () => boolean): Promise<void> {
	// fs.watch on macOS can be slow under load; poll instead of one sleep.
	for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(50)
}

// External editors and other processes replace files atomically.
function replace(path: string, text: string): void {
	writeFileSync(`${path}.ext`, text)
	renameSync(`${path}.ext`, path)
}

test('missing file yields defaults and reading never creates it; file values win', async () => {
	let path = `${dir}/missing.ason`
	let data = live(path, { foo: 1, deep: { bar: 'x' }, list: [1] }, { watch: false })
	expect(data.foo).toBe(1)
	expect(data.deep.bar).toBe('x')
	expect(data.list[0]).toBe(1)
	await tick()
	expect(existsSync(path)).toBe(false)
	// File values win; missing keys keep defaults.
	let existing = `${dir}/existing.ason`
	writeFileSync(existing, ason.stringify({ foo: 42 }) + '\n')
	let read = live(existing, { foo: 1, bar: 'default' }, { watch: false })
	expect(read.foo).toBe(42)
	expect(read.bar).toBe('default')
})

test('nested, array and delete mutations are deferred, coalesced and do not leak into defaults', async () => {
	let path = `${dir}/auto.ason`
	let defaults = { count: 0, deep: { v: 1 }, list: [1], gone: true }
	let data = live<Record<string, any>>(path, defaults, { watch: false })
	data.count = 5
	data.count = 10
	data.deep.v = 2
	data.list.push(2)
	delete data.gone
	expect(existsSync(path)).toBe(false)
	await tick()
	expect(disk(path)).toEqual({ count: 10, deep: { v: 2 }, list: [1, 2] })
	expect(defaults).toEqual({ count: 0, deep: { v: 1 }, list: [1], gone: true })
})

test('reading and no-op writes leave the file byte-for-byte alone', async () => {
	let path = `${dir}/untouched.ason`
	let text = '{\n\t// hand-written\n\tmodel: "opus",  deep: { v: 1 },\n}\n'
	writeFileSync(path, text)
	let data = live(path, { model: '', deep: { v: 0 }, extra: 'default' }, { watch: false })
	void data.deep.v
	data.model = 'opus'
	await tick()
	expect(readFileSync(path, 'utf8')).toBe(text)
})

test('save writes immediately and atomically', () => {
	let path = `${dir}/save.ason`
	let data = live(path, { x: 0 }, { watch: false })
	data.x = 99
	liveFiles.save(data)
	expect(disk(path)).toEqual({ x: 99 })
	expect(readdirSync(dir)).toEqual(['save.ason'])
})

test('mode keeps secrets owner-only despite stale temp files and old modes', () => {
	let path = `${dir}/secret.ason`
	writeFileSync(path, ason.stringify({ token: 'old' }) + '\n', { mode: 0o644 })
	chmodSync(path, 0o644)
	// A temp file left behind by a crashed run, world-readable.
	writeFileSync(`${path}.tmp.${process.pid}`, 'stale', { mode: 0o644 })
	chmodSync(`${path}.tmp.${process.pid}`, 0o644)
	let data = live(path, { token: '' }, { watch: false, mode: 0o600 })
	data.token = 'sekret'
	liveFiles.save(data)
	expect(statSync(path).mode & 0o777).toBe(0o600)
	expect(disk(path).token).toBe('sekret')
})

test('malformed file is an error naming the path, without echoing content', () => {
	let path = `${dir}/bad.ason`
	let text = "{ token: 'sk-secret-value' oops }"
	writeFileSync(path, text)
	let caught: Error | undefined
	try {
		live(path, { token: '' }, { watch: false })
	} catch (e) {
		caught = e as Error
	}
	expect(caught?.message).toContain(path)
	expect(caught?.message).not.toContain('sk-secret-value')
	expect(readFileSync(path, 'utf8')).toBe(text)
})

test('write errors: save throws, deferred writes report and retry', async () => {
	let path = `${dir}/nodir/file.ason`
	let data = live(path, { v: 0 }, { watch: false })
	data.v = 1
	await tick()
	expect(errors.length).toBe(1)
	expect(errors[0]!.message).toContain(path)
	expect(data.v).toBe(1)
	expect(() => liveFiles.save(data)).toThrow()
	// Once the directory exists, the still-pending change goes through.
	mkdirSync(`${dir}/nodir`)
	liveFiles.save(data)
	expect(disk(path)).toEqual({ v: 1 })
})

test('external atomic replacement updates the same object', async () => {
	let path = `${dir}/watched.ason`
	writeFileSync(path, ason.stringify({ v: 1, removed: true }) + '\n')
	let data = live<Record<string, any>>(path, { v: 0 })
	await Bun.sleep(50)
	replace(path, ason.stringify({ v: 99, added: 'yes' }) + '\n')
	await until(() => data.v === 99)
	expect(data.v).toBe(99)
	expect(data.added).toBe('yes')
	expect('removed' in data).toBe(false)
	// External content is not echoed back as a rewrite.
	expect(readFileSync(path, 'utf8')).toBe(ason.stringify({ v: 99, added: 'yes' }) + '\n')
})

test('own writes are not reloaded over newer in-memory values', async () => {
	let path = `${dir}/own.ason`
	let data = live(path, { v: 0 })
	await Bun.sleep(50)
	for (let i = 1; i <= 20; i++) {
		data.v = i
		await Bun.sleep(10)
	}
	await Bun.sleep(200)
	expect(data.v).toBe(20)
	expect(disk(path)).toEqual({ v: 20 })
})

test('malformed external edit is reported and never overwritten', async () => {
	let path = `${dir}/broken.ason`
	writeFileSync(path, ason.stringify({ v: 1 }) + '\n')
	let data = live(path, { v: 0 })
	await Bun.sleep(50)
	replace(path, '{ v: ')
	await until(() => errors.length > 0)
	expect(errors[0]?.message).toContain(path)
	expect(data.v).toBe(1)
	data.v = 2
	await tick()
	expect(readFileSync(path, 'utf8')).toBe('{ v: ')
	expect(() => liveFiles.save(data)).toThrow()
	expect(readFileSync(path, 'utf8')).toBe('{ v: ')
	// A fixed file is picked up again and writes resume.
	replace(path, ason.stringify({ v: 3 }) + '\n')
	await until(() => data.v === 3)
	expect(data.v).toBe(3)
	data.v = 4
	liveFiles.save(data)
	expect(disk(path)).toEqual({ v: 4 })
})

test('keepBroken starts a malformed file from defaults and loads it once fixed', async () => {
	let path = `${dir}/user.ason`
	writeFileSync(path, "{ token: 'sk-secret-value' oops }")
	let changes: (Error | null)[] = []
	let data = live<Record<string, any>>(path, { v: 0 }, { keepBroken: true, onChange: (e) => changes.push(e) })
	expect(data.v).toBe(0)
	expect(errors.length).toBe(1)
	expect(errors[0]!.message).toContain(path)
	expect(errors[0]!.message).not.toContain('sk-secret-value')
	expect(liveFiles.brokenError(data)?.message).toContain(path)
	// Still never written over.
	data.v = 1
	await tick()
	expect(readFileSync(path, 'utf8')).toContain('oops')
	replace(path, ason.stringify({ v: 3 }) + '\n')
	await until(() => data.v === 3)
	expect(data.v).toBe(3)
	expect(liveFiles.brokenError(data)).toBe(null)
	expect(changes.at(-1)).toBe(null)
})

test('onChange hears external edits and breakage, not own writes', async () => {
	let path = `${dir}/notify.ason`
	let changes: (Error | null)[] = []
	let data = live(path, { v: 0 }, { onChange: (e) => changes.push(e) })
	data.v = 1
	liveFiles.save(data)
	await Bun.sleep(200)
	expect(changes).toEqual([])
	replace(path, ason.stringify({ v: 2 }) + '\n')
	await until(() => changes.length > 0)
	expect(changes).toEqual([null])
	replace(path, '{ v: ')
	await until(() => changes.length > 1)
	expect(changes[1]?.message).toContain(path)
})

test('close flushes, stops watching and rejects later changes', async () => {
	let path = `${dir}/close.ason`
	let data = live(path, { v: 0 })
	data.v = 5
	liveFiles.close(data)
	expect(disk(path)).toEqual({ v: 5 })
	replace(path, ason.stringify({ v: 7 }) + '\n')
	await Bun.sleep(300)
	expect(data.v).toBe(5)
	expect(() => {
		data.v = 6
	}).toThrow()
})
