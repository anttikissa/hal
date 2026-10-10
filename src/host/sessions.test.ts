import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
let home = ''

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-sessions-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
})

afterEach(() => {
	sessions.closeAll()
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

const metaFile = (id: string) => `${paths.sessionDir(id)}/session.ason`
const onDisk = (id: string) => ason.parse(readFileSync(metaFile(id), 'utf8')) as any

test('create writes metadata into its own directory and opens the session; changes persist', async () => {
	let before = Date.now()
	let meta = sessions.create({ cwd: '/tmp/work', model: 'openai/gpt-x', name: 'first' })
	expect(existsSync(paths.sessionDir(meta.id))).toBe(true)
	let disk = onDisk(meta.id)
	expect(disk).toMatchObject({ id: meta.id, cwd: '/tmp/work', model: 'openai/gpt-x', name: 'first' })
	expect(Date.parse(disk.createdAt)).toBeGreaterThanOrEqual(before - 1000)
	expect(sessions.openIds()).toEqual([meta.id])
	// Changes to open metadata persist.
	meta.name = 'renamed'
	await Bun.sleep(0)
	expect(onDisk(meta.id).name).toBe('renamed')
})

test('create defaults the model at call time', () => {
	let orig = models.defaultModel
	models.defaultModel = () => 'test/override'
	try {
		expect(sessions.create({ cwd: '/' }).model).toBe('test/override')
	} finally {
		models.defaultModel = orig
	}
})

test('several sessions can be open at once, each with a distinct id', () => {
	let ids = [1, 2, 3].map(() => sessions.create({ cwd: '/' }).id)
	expect(new Set(ids).size).toBe(3)
	expect(sessions.openIds()).toEqual(ids)
	expect(readdirSync(paths.sessionsDir()).sort()).toEqual([...ids].sort())
	for (let id of ids) expect(() => paths.sessionDir(id)).not.toThrow()
})

test('close keeps the session on disk; open brings it back', () => {
	let meta = sessions.create({ cwd: '/a', name: 'keep' })
	sessions.close(meta.id)
	expect(sessions.openIds()).toEqual([])
	// No history file needed.
	expect(readdirSync(paths.sessionDir(meta.id))).toEqual(['session.ason'])
	let again = sessions.open(meta.id)
	expect(again).toMatchObject({ id: meta.id, cwd: '/a', name: 'keep' })
	expect(sessions.open(meta.id)).toBe(again)
	expect(sessions.openIds()).toEqual([meta.id])
})

test('on a fresh home, list is empty and open fails for an unknown session without creating it', () => {
	expect(sessions.list()).toEqual([])
	expect(() => sessions.open('nope')).toThrow()
	expect(existsSync(paths.sessionDir('nope'))).toBe(false)
})

test('malformed metadata is reported, never replaced', () => {
	let meta = sessions.create({ cwd: '/' })
	sessions.closeAll()
	writeFileSync(metaFile(meta.id), '{ id: ')
	expect(() => sessions.open(meta.id)).toThrow(/malformed/)
	expect(readFileSync(metaFile(meta.id), 'utf8')).toBe('{ id: ')
	expect(sessions.openIds()).toEqual([])
})

test('metadata missing required fields is reported, not filled in', () => {
	mkdirSync(paths.sessionDir('bare'), { recursive: true })
	writeFileSync(metaFile('bare'), "{ name: 'x' }\n")
	expect(() => sessions.open('bare')).toThrow(/bare/)
	expect(readFileSync(metaFile('bare'), 'utf8')).toBe("{ name: 'x' }\n")
})

test('list reads every session on disk, open or not, and reports broken ones', () => {
	let a = sessions.create({ cwd: '/a' })
	let b = sessions.create({ cwd: '/b' })
	sessions.close(b.id)
	mkdirSync(paths.sessionDir('99-bad'), { recursive: true })
	writeFileSync(metaFile('99-bad'), 'not ason {')
	mkdirSync(paths.sessionDir('99-nil'), { recursive: true })
	let listed = sessions.list()
	let byId = Object.fromEntries(listed.map((s) => [s.id, s]))
	expect(byId[a.id]!.meta?.cwd).toBe('/a')
	expect(byId[b.id]!.meta?.cwd).toBe('/b')
	expect(byId['99-bad']!.meta).toBeUndefined()
	expect(byId['99-bad']!.error).toMatch(/malformed/)
	expect(byId['99-nil']!.error).toBeTruthy()
	// Listing is read-only: it neither opens nor repairs anything.
	expect(sessions.openIds()).toEqual([a.id])
	expect(readFileSync(metaFile('99-bad'), 'utf8')).toBe('not ason {')
})

test('newest is the latest-created readable session of the newest day', () => {
	let metas = Array.from({ length: 3 }, (_, i) => sessions.create({ cwd: `/s${i}` }))
	// Same day; words don't sort by creation, createdAt decides.
	metas.forEach((m, i) => ((m.createdAt = new Date(Date.UTC(2026, 0, 1, 2 - i)).toISOString()), liveFiles.save(m)))
	sessions.closeAll()
	// A newer day whose only session's metadata is broken is skipped.
	mkdirSync(paths.sessionDir('99-bad'), { recursive: true })
	writeFileSync(metaFile('99-bad'), 'not ason {')
	expect(sessions.newest()).toBe(metas[0]!.id)
})
