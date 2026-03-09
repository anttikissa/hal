import { test, expect, afterEach } from 'bun:test'
import { rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { liveFile } from './live-file.ts'
import { parse } from './utils/ason.ts'

const TEST_FILE = `/tmp/hal-livefile-test-${process.pid}.ason`

afterEach(() => {
	try { rmSync(TEST_FILE) } catch {}
})

test('auto-saves on property mutation', async () => {
	const obj = liveFile(TEST_FILE, { defaults: { x: 1, y: 'hello' }, watch: false })
	expect(obj.x).toBe(1)
	obj.x = 42
	// Flush happens on next microtask
	await new Promise(r => queueMicrotask(r))
	const disk = parse(readFileSync(TEST_FILE, 'utf-8')) as any
	expect(disk.x).toBe(42)
	expect(disk.y).toBe('hello')
})

test('loads existing data from disk', () => {
	writeFileSync(TEST_FILE, "{ x: 99, y: 'from disk' }\n")
	const obj = liveFile(TEST_FILE, { defaults: { x: 1, y: 'default' }, watch: false })
	expect(obj.x).toBe(99)
	expect(obj.y).toBe('from disk')
})

test('save() flushes synchronously', () => {
	const obj = liveFile(TEST_FILE, { defaults: { v: 0 }, watch: false }) as any
	obj.v = 7
	obj.save()
	const disk = parse(readFileSync(TEST_FILE, 'utf-8')) as any
	expect(disk.v).toBe(7)
})

test('creates file if it does not exist', async () => {
	const obj = liveFile(TEST_FILE, { defaults: { a: 1 }, watch: false })
	obj.a = 2
	await new Promise(r => queueMicrotask(r))
	expect(existsSync(TEST_FILE)).toBe(true)
})

test('deep mutation triggers save', async () => {
	const obj = liveFile(TEST_FILE, { defaults: { nested: { a: 1, b: 2 } }, watch: false })
	obj.nested.a = 99
	await new Promise(r => queueMicrotask(r))
	const disk = parse(readFileSync(TEST_FILE, 'utf-8')) as any
	expect(disk.nested.a).toBe(99)
	expect(disk.nested.b).toBe(2)
})
