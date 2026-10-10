import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { lines } from '../common/lines.ts'
import { ason } from '../common/ason.ts'
import { changeCleanup } from './change-cleanup.ts'
import { fileTracking } from './file-tracking.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'

let home: string, previousHome: string | undefined
let id = '1-cleanup', ts = '2026-10-10T00:00:00Z'
let originalFilter = fileTracking.filter, originalValidate = changeCleanup.validate, originalBackup = changeCleanup.backup

beforeEach(() => {
	previousHome = process.env.HAL_HOME
	home = mkdtempSync(`${tmpdir()}/hal-cleanup-`)
	process.env.HAL_HOME = home
	paths.init()
	mkdirSync(paths.sessionDir(id))
})

afterEach(() => {
	fileTracking.filter = originalFilter
	changeCleanup.validate = originalValidate
	changeCleanup.backup = originalBackup
	if (server.state.lockFd !== null) { closeSync(server.state.lockFd); server.state.lockFd = null }
	pages.reset()
	rmSync(home, { recursive: true, force: true })
	if (previousHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = previousHome
})

function path(): string { return `${paths.sessionDir(id)}/history.asonl` }
function file(name: string) { return { path: name, before: null, after: 'a'.repeat(64) } }
function fixture(): string {
	return [
		lines.encode({ type: 'user', blocks: [{ type: 'text', text: 'café 🚀' }], ts }),
		lines.encode({ type: 'file_changes', n: 900, cwd: home, toolId: 'tool', call: 700, ts, files: [file('node_modules/large.js'), file('.git/index'), file('src/useful.ts'), file('../outside.ts')] }),
		lines.encode({ type: 'assistant', n: 700, block: { type: 'tool_call', id: 'tool', name: 'bash', input: { command: 'true' } }, ts }),
		lines.encode({ type: 'user', blocks: [{ type: 'tool_result', id: 'tool', output: 'full result' }], ts }),
		lines.encode({ type: 'turn_end', n: 901, ts }),
	].join('')
}

async function read(filePath: string) {
	let records = []
	for await (let item of changeCleanup.records(filePath)) records.push(item)
	return records
}

test('cleanup preview does not write; apply preserves records, legacy numbers, useful changes, blobs and rebuilt offsets', async () => {
	let original = fixture()
	writeFileSync(path(), original)
	writeFileSync(pages.marksPath(id), ason.stringify({ size: original.length, next: 999, changes: [1], files: 999, inbox: {} }))
	mkdirSync(`${paths.sessionDir(id)}/file-blobs`)
	let blob = `${paths.sessionDir(id)}/file-blobs/${'a'.repeat(64)}`
	writeFileSync(blob, 'snapshot contents')
	let before = await read(path())
	let names = readdirSync(paths.sessionDir(id)).sort()
	let preview = await changeCleanup.run(id)
	expect(preview.removed).toBe(2)
	expect(preview.backup).toBeUndefined()
	expect(readFileSync(path(), 'utf8')).toBe(original)
	expect(readdirSync(paths.sessionDir(id)).sort()).toEqual(names)
	let result = await changeCleanup.run(id, true)
	expect(result.removed).toBe(2)
	expect(result.records).toBe(5)
	expect(readFileSync(result.backup!, 'utf8')).toBe(original)
	expect(statSync(result.backup!).mode & 0o777).toBe(0o600)
	expect(statSync(path()).mode & 0o777).toBe(0o600)
	expect(readFileSync(blob, 'utf8')).toBe('snapshot contents')
	let after = await read(path())
	expect(after.map((i) => i.record.n)).toEqual(before.map((i) => i.record.n))
	for (let i of [0, 2, 3, 4]) expect(after[i]!.record).toEqual(before[i]!.record)
	let observation = before[1]!.record
	if (observation.type !== 'file_changes') throw new Error('missing file observation')
	expect(after[1]!.record).toEqual({ ...observation, files: [file('src/useful.ts'), file('../outside.ts')] })
	let marks = ason.parse(readFileSync(pages.marksPath(id), 'utf8')) as any
	expect(marks.changes).toEqual([after[1]!.offset])
	expect(marks.files).toBe(2)
	expect(marks.prompt).toBe(after[0]!.offset)
	expect(marks.turn).toBe(after[4]!.offset)
	expect(marks.next).toBe(Math.max(...after.map((i) => i.record.n!)) + 1)
	expect(marks.size).toBe(Buffer.byteLength(readFileSync(path(), 'utf8')))
	expect(server.state.lockFd).toBeNull()
})

test('cleanup uses native Git ignore behavior but keeps tracked ignored files', async () => {
	let git = (...args: string[]) => {
		let result = Bun.spawnSync(['git', '-C', home, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
		if (result.exitCode) throw new Error(result.stderr.toString())
	}
	git('init', '-q')
	writeFileSync(`${home}/.gitignore`, '*.generated\n')
	writeFileSync(`${home}/tracked.generated`, 'tracked')
	git('add', '-f', 'tracked.generated')
	writeFileSync(path(), lines.encode({ type: 'file_changes', cwd: home, toolId: 'tool', ts, files: [file('noise.generated'), file('tracked.generated'), file('new.ts')] }))
	let result = await changeCleanup.run(id, true)
	expect(result.removed).toBe(1)
	let record = (await read(path()))[0]!.record
	expect(record.type === 'file_changes' && record.files.map((f) => f.path)).toEqual(['tracked.generated', 'new.ts'])
})

test('cleanup checks symlink ancestors without passing descendant pathspecs to Git', async () => {
	let result = Bun.spawnSync(['git', '-C', home, 'init', '-q'])
	if (result.exitCode) throw new Error(result.stderr.toString())
	let outside = mkdtempSync(`${tmpdir()}/hal-cleanup-target-`)
	try {
		mkdirSync(`${outside}/nested`)
		symlinkSync(outside, `${home}/alias`)
		writeFileSync(`${home}/.gitignore`, 'ignored-alias\n')
		symlinkSync(outside, `${home}/ignored-alias`)
		writeFileSync(path(), lines.encode({ type: 'file_changes', cwd: home, toolId: 'tool', ts, files: [file('alias/nested/output.txt'), file('ignored-alias/nested/output.txt'), file('node_modules/x')] }))
		let cleaned = await changeCleanup.run(id, true)
		expect(cleaned.removed).toBe(2)
		let record = (await read(path()))[0]!.record
		expect(record.type === 'file_changes' && record.files.map((f) => f.path)).toEqual(['alias/nested/output.txt'])
	} finally { rmSync(outside, { recursive: true, force: true }) }
})

test('malformed first and torn last records abort without replacing history or marks', async () => {
	for (let text of ['invalid\n' + fixture(), fixture() + '{ type:']) {
		writeFileSync(path(), text)
		writeFileSync(pages.marksPath(id), 'original marks')
		await expect(changeCleanup.run(id, true)).rejects.toThrow('malformed history at byte')
		expect(readFileSync(path(), 'utf8')).toBe(text)
		expect(readFileSync(pages.marksPath(id), 'utf8')).toBe('original marks')
		expect(readdirSync(paths.sessionDir(id)).sort()).toEqual(['history.asonl', 'marks.ason'])
		expect(server.state.lockFd).toBeNull()
	}
})

test('cleanup refuses symlink histories and releases the home lock', async () => {
	let target = `${home}/source.asonl`
	writeFileSync(target, fixture())
	symlinkSync(target, path())
	await expect(changeCleanup.run(id, true)).rejects.toThrow('regular, non-symlink history file')
	expect(readFileSync(target, 'utf8')).toBe(fixture())
	expect(server.state.lockFd).toBeNull()
	expect(readdirSync(paths.sessionDir(id))).toEqual(['history.asonl'])
})

test('candidate corruption is caught before replacing history', async () => {
	writeFileSync(path(), fixture())
	changeCleanup.validate = async (candidate, expected, count) => {
		appendFileSync(candidate, lines.encode({ type: 'turn_end', ts, n: 9999 }))
		return originalValidate(candidate, expected, count)
	}
	await expect(changeCleanup.run(id, true)).rejects.toThrow('cleanup validation failed')
	expect(readFileSync(path(), 'utf8')).toBe(fixture())
	expect(readdirSync(paths.sessionDir(id))).toEqual(['history.asonl'])
})

test('failed backup never replaces history or describes partial bytes as recoverable', async () => {
	writeFileSync(path(), fixture())
	changeCleanup.backup = async (_source, target) => {
		writeFileSync(target, 'partial', { mode: 0o600, flag: 'wx' })
		throw new Error('ENOSPC: simulated full disk')
	}
	let error = await changeCleanup.run(id, true).catch((e: Error) => e)
	expect(error).toBeInstanceOf(Error)
	expect(String(error)).toContain('ENOSPC: simulated full disk')
	expect(String(error)).toContain('Incomplete backup; original history was not replaced')
	expect(String(error)).not.toContain('Recoverable original:')
	expect(readFileSync(path(), 'utf8')).toBe(fixture())
	expect(server.state.lockFd).toBeNull()
})

test('source mutation is detected and retains both current history and recoverable backup', async () => {
	let original = fixture(), appended = lines.encode({ type: 'notice', ts, text: 'external writer', n: 9999 })
	writeFileSync(path(), original)
	let once = false
	fileTracking.filter = async (...args) => {
		if (!once) { once = true; appendFileSync(path(), appended) }
		return originalFilter(...args)
	}
	await expect(changeCleanup.run(id, true)).rejects.toThrow('history changed during cleanup')
	expect(readFileSync(path(), 'utf8')).toBe(original + appended)
	let backups = readdirSync(paths.sessionDir(id)).filter((name) => name.startsWith('history.asonl.before-cleanup-'))
	expect(backups).toHaveLength(1)
	expect(readFileSync(`${paths.sessionDir(id)}/${backups[0]}`, 'utf8')).toBe(original + appended)
	expect(server.state.lockFd).toBeNull()
})

test('exclusive host lock refuses cleanup and prevents another process taking over', async () => {
	writeFileSync(path(), fixture())
	expect(server.tryLock()).toBe(true)
	await expect(changeCleanup.run(id, true)).rejects.toThrow('host is running')
	let modulePath = `${import.meta.dir}/change-cleanup.ts`
	let child = Bun.spawnSync(['bun', modulePath, '--apply', id], { env: process.env })
	expect(child.exitCode).not.toBe(0)
	expect(child.stderr.toString()).toContain('host is running')
	expect(readFileSync(path(), 'utf8')).toBe(fixture())
	closeSync(server.state.lockFd!)
	server.state.lockFd = null
	let tested = false
	fileTracking.filter = async (...args) => {
		let result = Bun.spawnSync(['bun', '-e', `let {server} = await import(${JSON.stringify(`${import.meta.dir}/server.ts`)}); process.exit(server.tryLock() ? 1 : 0)`], { env: process.env })
		expect(result.exitCode).toBe(0)
		tested = true
		return originalFilter(...args)
	}
	await changeCleanup.run(id, true)
	expect(tested).toBe(true)
})
