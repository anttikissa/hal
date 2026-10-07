import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { lines } from '../common/lines.ts'
import { inbox } from '../common/inbox.ts'
import { titles } from '../common/titles.ts'
import { transcript } from '../common/transcript.ts'
import { deliveryMigration } from './delivery-migration.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'

let home = '', savedHome = process.env.HAL_HOME
const ts = '2026-10-07T12:00:00Z'
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-delivery-`)
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

test('startup converts only stored provenance, preserves block addresses and rebuilds projections', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id, path = history.file(id)
	let legacy = [
		{ type: 'inbox', id: 'soft', text: 'héllo', interject: true, ts },
		{ type: 'user', blocks: [{ type: 'text', text: 'héllo' }, { type: 'text', text: 'fresh' }], inbox: ['soft'], ts },
		{ type: 'assistant', block: { type: 'tool_call', id: 'call', name: 'send', input: { steering: true, interject: true, queue: true, text: 'steering: true' } }, ts, n: 9000 },
		{ type: 'inbox', id: 'q', text: 'later', queue: true, from: 'other', advisory: true, ts },
		{ type: 'inbox', id: 'automatic', text: 'report', from: 'agent', advisory: true, ts },
		{ type: 'output', text: 'clear', transition: { id: 'intent', kind: 'clear', sender: { from: 'agent', interject: true } }, ts },
	]
	let raw = legacy.map((r) => lines.encode(r)).join(''), offsets: number[] = [], at = 0
	for (let r of legacy) { offsets.push(at + 1); at += Buffer.byteLength(lines.encode(r)) }
	writeFileSync(path, raw)
	writeFileSync(`${paths.sessionDir(id)}/marks.ason`, ason.stringify({ size: Buffer.byteLength(raw), next: 10000, inbox: {} }))
	writeFileSync(`${paths.stateDir()}/find.sqlite`, 'stale')
	expect(await server.serve()).toBe(true)
	let records = history.readSync(id)
	expect(records.map((r) => r.n)).toEqual(offsets.map((n, i) => i === 2 ? 9000 : n))
	expect(records[1]).toMatchObject({ blocks: [{ delivery: 'next-round' }, { text: 'fresh' }] })
	let prompt = records[1]
	if (prompt?.type !== 'user') throw new Error('missing prompt')
	expect(prompt.blocks[1]).not.toHaveProperty('delivery')
	expect(records[2]).toMatchObject({ block: legacy[2]!.block })
	expect(records[5]).toMatchObject({ transition: { sender: { from: 'agent', delivery: 'next-round' } } })
	let waiting = inbox.pending(records)
	expect(waiting).toMatchObject([{ id: 'automatic', advisory: true, delivery: 'next-round' }, { id: 'q', advisory: true, delivery: 'after-turn' }])
	expect(titles.receipt(transcript.waitingItem(waiting[0]!))).toBe(1)
	expect(readFileSync(`${path}.before-rqq`, 'utf8')).toBe(raw)
	expect(existsSync(`${paths.stateDir()}/find.sqlite`)).toBe(false)
	expect(history.append(id, { type: 'continue' }).n).toBe(10000)
	let once = readFileSync(path, 'utf8')
	await deliveryMigration.run()
	expect(readFileSync(path, 'utf8')).toBe(once)
})

for (let tail of ['{ broken\n', '{ torn']) test(`conversion aborts before replacing any history on ${tail.trim()}`, async () => {
	let first = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	let second = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	let raw = lines.encode({ type: 'inbox', id: 'q', text: 'later', queue: true, ts })
	writeFileSync(history.file(first), raw)
	writeFileSync(history.file(second), raw + tail)
	await expect(deliveryMigration.run()).rejects.toThrow(history.file(second))
	await expect(deliveryMigration.run()).rejects.toThrow(tail.trim())
	expect(readFileSync(history.file(first), 'utf8')).toBe(raw)
	expect(readFileSync(history.file(second), 'utf8')).toBe(raw + tail)
	expect(existsSync(`${paths.stateDir()}/delivery-format.ason`)).toBe(false)
	expect(existsSync(`${history.file(first)}.delivery-next`)).toBe(false)
})

test('a partial installation resumes without restaging installed histories or replacing their backups', async () => {
	let first = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	let second = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	let raw = lines.encode({ type: 'inbox', id: 'q', text: 'later', queue: true, ts })
	writeFileSync(history.file(first), raw)
	writeFileSync(history.file(second), raw)
	let staged = await deliveryMigration.stage(history.file(first))
	deliveryMigration.install(staged)
	let installedInode = statSync(history.file(first)).ino
	await deliveryMigration.run()
	expect(statSync(history.file(first)).ino).toBe(installedInode)
	expect(readFileSync(`${history.file(first)}.before-rqq`, 'utf8')).toBe(raw)
	expect(history.readSync(second)).toMatchObject([{ type: 'inbox', delivery: 'after-turn' }])
})

test('insufficient space refuses conversion before creating stages or backups', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	let raw = lines.encode({ type: 'inbox', id: 'q', text: 'later', queue: true, ts })
	writeFileSync(history.file(id), raw)
	let space = deliveryMigration.space
	deliveryMigration.space = (staged) => space(staged.map((s) => ({ ...s, bytes: Number.MAX_SAFE_INTEGER })))
	try { await expect(deliveryMigration.run()).rejects.toThrow('free bytes') }
	finally { deliveryMigration.space = space }
	expect(readFileSync(history.file(id), 'utf8')).toBe(raw)
	expect(existsSync(`${history.file(id)}.delivery-next`)).toBe(false)
	expect(existsSync(`${history.file(id)}.before-rqq`)).toBe(false)
})

test('temporary startup conversion expires October 10', () => {
	expect(Date.now(), 'remove delivery-migration.ts, its server startup hook and migration tests').toBeLessThan(Date.parse('2026-10-10T00:00:00Z'))
})
