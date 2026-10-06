import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { states } from '../common/states.ts'
import { history } from './history.ts'
import { historyMigration } from './history-migration.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'

let home = '', savedHome = process.env.HAL_HOME
const ts = '2026-10-04T00:00:00Z'
const form = { text: 'Question', fields: [{ type: 'text' as const, name: 'answer' }] }
const call = (id: string, name: string): HistoryRecord => ({ type: 'assistant', block: { type: 'tool_call', id, name, input: {} }, ts })
const result = (id: string): HistoryRecord => ({ type: 'user', blocks: [{ type: 'tool_result', id, output: id }], ts })
const question = (id: string, call: string): Extract<HistoryRecord, { type: 'question' }> => ({ type: 'question', id, call, form, ts })

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-migration-`)
	process.env.HAL_HOME = home
	paths.init()
})

afterEach(async () => {
	await server.stop()
	host.reset()
	sessions.closeAll()
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('retiring ask keeps mixed results, reused call IDs, approval and command questions', () => {
	let records: HistoryRecord[] = [
		call('a', 'ask'), call('b', 'read'), question('qa', 'a'),
		{ type: 'answer', question: 'qa', answers: { answer: 'old' }, ts },
		{ type: 'user', blocks: [{ type: 'tool_result', id: 'a', output: 'old' }, { type: 'tool_result', id: 'b', output: 'kept' }, { type: 'text', text: 'kept prompt' }], ts },
		call('a', 'bash'), question('approval', 'a'), result('a'),
		call('a', 'ask'), { ...question('command', 'a'), from: { command: 'login', args: '' } },
		{ type: 'answer', question: 'command', answers: {}, ts }, question('open', 'a'),
	]
	let stripped = historyMigration.strip(records)
	expect(stripped).toEqual([records[1]!, { ...(records[4] as Extract<HistoryRecord, { type: 'user' }>), blocks: (records[4] as Extract<HistoryRecord, { type: 'user' }>).blocks.slice(1) }, ...records.slice(5, 8), ...records.slice(9, 11)])
	expect(historyMigration.strip(stripped)).toEqual(stripped)
})

test('host migration removes parked ask history atomically, preserves addresses and invalidates projections', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	let path = history.file(id)
	let records: HistoryRecord[] = [{ type: 'user', blocks: [{ type: 'text', text: 'go' }], ts }, call('a', 'ask'), question('open', 'a')]
	let raw = records.map((r) => lines.encode(r)).join('')
	writeFileSync(path, raw)
	writeFileSync(`${paths.sessionDir(id)}/marks.ason`, ason.stringify({ size: raw.length, turn: 999, next: 9999, inbox: {} }))
	writeFileSync(`${paths.stateDir()}/find.sqlite`, 'stale search cache')
	expect(await server.serve()).toBe(true)
	let migrated = history.readSync(id)
	expect(migrated).toEqual([{ ...records[0]!, n: 1 }])
	expect(states.fromHistory(migrated)).toEqual({ type: 'running', phase: 'requesting' })
	expect(replay.toMessages(migrated)[0]?.blocks).toMatchObject([{ type: 'text', text: expect.stringContaining('go') }])
	expect(existsSync(`${path}.migrate`)).toBe(false)
	expect(existsSync(`${paths.stateDir()}/find.sqlite`)).toBe(false)
	let originalLast = Buffer.byteLength(records.slice(0, 2).map((r) => lines.encode(r)).join('')) + 1
	expect(history.append(id, { type: 'continue' }).n).toBe(Math.max(originalLast + 1, 9999))
	let once = readFileSync(path, 'utf8')
	await historyMigration.run()
	expect(readFileSync(path, 'utf8')).toBe(once)
})

test('migration adjusts context surgery targets without changing surviving record numbers', () => {
	let records: HistoryRecord[] = [{ ...call('a', 'ask'), n: 1 }, { ...result('a'), n: 2 }, { ...call('b', 'read'), n: 3 }, { ...result('b'), n: 4 }, { type: 'rebase', base: 4, drop: [1], edit: [{ n: 2, text: 'removed' }, { n: 4, text: 'edited' }], n: 5, ts }]
	let stripped = historyMigration.strip(records)
	expect(stripped.at(-1)).toMatchObject({ drop: [], edit: [{ n: 4, text: 'edited' }] })
	expect(replay.current(stripped).at(-1)).toMatchObject({ n: 4, blocks: [{ type: 'tool_result', id: 'b', output: 'edited' }] })
})

test('a malformed complete record fails with its path and input, without replacing history', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	let path = history.file(id)
	let raw = lines.encode(call('a', 'ask')) + '{ broken record\n'
	writeFileSync(path, raw)
	await expect(historyMigration.run()).rejects.toThrow(path)
	await expect(historyMigration.run()).rejects.toThrow('{ broken record')
	expect(readFileSync(path, 'utf8')).toBe(raw)
	expect(existsSync(`${paths.stateDir()}/migrations.ason`)).toBe(false)
})

test('migration leaves a torn last write for normal history repair', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	let path = history.file(id)
	let prompt: HistoryRecord = { type: 'user', blocks: [{ type: 'text', text: 'go' }], ts }
	writeFileSync(path, lines.encode(prompt) + lines.encode(call('a', 'ask')) + '{ torn')
	await historyMigration.run()
	expect(readFileSync(path, 'utf8').endsWith('{ torn')).toBe(true)
	await history.open(id)
	expect(history.readSync(id)).toEqual([{ ...prompt, n: 1 }])
})
