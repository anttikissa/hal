import { test, expect, beforeEach, afterEach } from 'bun:test'
import { liveFiles } from './live-file.ts'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ason } from './ason.ts'

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'livefile-test-'))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

test('loads defaults when file does not exist', () => {
	const data = liveFiles.liveFile(join(dir, 'missing.ason'), { foo: 1, bar: 'hello' }, { watch: false })
	expect(data.foo).toBe(1)
	expect(data.bar).toBe('hello')
})

test('loads from disk, merging over defaults', () => {
	const path = join(dir, 'existing.ason')
	writeFileSync(path, ason.stringify({ foo: 42 }) + '\n')
	const data = liveFiles.liveFile(path, { foo: 1, bar: 'default' }, { watch: false })
	expect(data.foo).toBe(42)
	expect(data.bar).toBe('default') // default preserved for missing keys
})

test('mutations auto-save on microtask', async () => {
	const path = join(dir, 'autosave.ason')
	const data = liveFiles.liveFile(path, { count: 0 }, { watch: false })
	data.count = 5
	data.count = 10 // coalesced
	// Flush happens on microtask
	await new Promise((r) => queueMicrotask(r))
	await Bun.sleep(0) // extra tick for rename
	const disk = ason.parse(readFileSync(path, 'utf-8')) as any
	expect(disk.count).toBe(10)
})

test('save() forces immediate flush', () => {
	const path = join(dir, 'forcesave.ason')
	const data = liveFiles.liveFile(path, { x: 0 }, { watch: false })
	data.x = 99
	liveFiles.save(data)
	const disk = ason.parse(readFileSync(path, 'utf-8')) as any
	expect(disk.x).toBe(99)
})

test('nested object mutations auto-save', async () => {
	const path = join(dir, 'nested.ason')
	const data = liveFiles.liveFile(path, { deep: { val: 1 } }, { watch: false })
	data.deep.val = 42
	await new Promise((r) => queueMicrotask(r))
	await Bun.sleep(0)
	const disk = ason.parse(readFileSync(path, 'utf-8')) as any
	expect(disk.deep.val).toBe(42)
})

test('onChange fires on external file change', async () => {
	const path = join(dir, 'watched.ason')
	writeFileSync(path, ason.stringify({ v: 1 }) + '\n')
	const data = liveFiles.liveFile(path, { v: 0 })
	expect(data.v).toBe(1)

	// Give Bun's directory watcher one tick to arm before we simulate an edit.
	await Bun.sleep(50)

	let called = false
	liveFiles.onChange(data, () => {
		called = true
	})

	// Simulate external edit via atomic rename (like real editors do).
	const tmp = path + '.tmp'
	writeFileSync(tmp, ason.stringify({ v: 99 }) + '\n')
	renameSync(tmp, path)
	// Poll until the watcher fires, rather than sleeping a fixed duration.
	// fs.watch on macOS can be slow under load.
	for (let i = 0; i < 100 && !called; i++) await Bun.sleep(50)

	expect(called).toBe(true)
	expect(data.v).toBe(99)
})

test('own writes do not trigger onChange', async () => {
	const path = join(dir, 'ownwrite.ason')
	const data = liveFiles.liveFile(path, { v: 0 })

	let called = false
	liveFiles.onChange(data, () => {
		called = true
	})

	data.v = 42
	liveFiles.save(data)
	await Bun.sleep(200)

	expect(called).toBe(false)
})

test('parse errors in file are ignored gracefully', () => {
	const path = join(dir, 'bad.ason')
	writeFileSync(path, '{{{{ not valid ason')
	const data = liveFiles.liveFile(path, { safe: true }, { watch: false })
	expect(data.safe).toBe(true) // defaults survive
})
