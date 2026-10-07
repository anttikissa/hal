// Plugin version history (task gev): the invariants its spec lists.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pluginHistory, type Version } from './plugin-history.ts'
import { plugins } from './plugins.ts'

let dir = ''
let reports: string[] = []
const records = () => readFileSync(join(dir, 'history.asonl'), 'utf8').trim().split('\n')
const versions = (file = 'a.ts') => [...pluginHistory.state.versions.values()].filter((v) => v.file === file)
const unmarked = (): Version[] => versions().map((v) => ({ ...v, received: undefined }))
const write = (text: string) => writeFileSync(join(dir, 'a.ts'), text)
const seen = () => pluginHistory.seen(join(dir, 'a.ts'))

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'hal-plugin-history-'))
	reports = []
	plugins.report = (text) => void reports.push(text)
	pluginHistory.init(dir)
})

afterEach(() => {
	pluginHistory.close()
	rmSync(dir, { recursive: true, force: true })
})

test('repeated events and restarts add no duplicate versions; edits while stopped are found and marked', () => {
	write('one')
	seen()
	seen()
	pluginHistory.init(dir)
	expect(records()).toHaveLength(1)
	write('two')
	pluginHistory.init(dir)
	let [first, second] = versions()
	expect(second).toMatchObject({ parent: first!.id, offline: true })
	expect(first!.offline).toBeUndefined()
	expect(pluginHistory.content(first!.hash!).toString()).toBe('one')
})

test('deletion is a tombstone, distinct from an empty file', () => {
	write('')
	seen()
	unlinkSync(join(dir, 'a.ts'))
	seen()
	seen()
	let [empty, gone] = versions()
	expect(empty!.hash).toBeDefined()
	expect(gone).toMatchObject({ deleted: true, parent: empty!.id })
	expect(gone!.hash).toBeUndefined()
	expect(versions()).toHaveLength(2)
})

test('reverting to earlier bytes is a new version descending from the edit', () => {
	for (let text of ['a', 'b', 'a']) {
		write(text)
		seen()
	}
	let [a, b, again] = versions()
	expect(again!.hash).toBe(a!.hash!)
	expect(again!.id).not.toBe(a!.id)
	expect(again!.parent).toBe(b!.id)
})

test('received versions keep id, time and ancestry, also when an older one is chosen', () => {
	let other = mkdtempSync(join(tmpdir(), 'hal-plugin-history-'))
	try {
		pluginHistory.init(other)
		writeFileSync(join(other, 'a.ts'), 'x')
		pluginHistory.seen(join(other, 'a.ts'))
		writeFileSync(join(other, 'a.ts'), 'y')
		pluginHistory.seen(join(other, 'a.ts'))
		let sent: Version[] = versions().map((v) => ({ ...v }))
		let bytes = new Map(sent.map((v) => [v.hash!, pluginHistory.content(v.hash!)]))
		pluginHistory.init(dir)
		pluginHistory.receive(sent, bytes)
		expect(unmarked()).toEqual(sent)
		pluginHistory.checkout(sent[0]!.id)
		expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('x')
		seen()
		pluginHistory.init(dir)
		expect(unmarked()).toEqual(sent)
		expect(pluginHistory.state.heads.get('a.ts')).toBe(sent[0]!.id)
		expect(() => pluginHistory.receive([{ ...sent[1]!, id: 'forged', ts: 'now' }], bytes)).toThrow('invalid')
	} finally {
		rmSync(other, { recursive: true, force: true })
	}
})

test('a torn last line is cut; a corrupt record is reported with its path and stops recording', () => {
	write('one')
	seen()
	appendFileSync(join(dir, 'history.asonl'), '{ file: "a.t')
	pluginHistory.init(dir)
	expect(reports).toEqual([])
	expect(records()).toHaveLength(1)
	appendFileSync(join(dir, 'history.asonl'), 'nonsense{\n')
	pluginHistory.init(dir)
	expect(reports[0]).toContain(`${join(dir, 'history.asonl')}:2`)
	write('two')
	seen()
	expect(records()).toHaveLength(2)
})
