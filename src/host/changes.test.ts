import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { changes } from './changes.ts'
import { changesPage } from './changes-page.ts'
import { fileChanges } from './file-changes.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { stats } from './stats.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'

let home = '', id = ''
let saved = process.env.HAL_HOME
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-changes-`)
	process.env.HAL_HOME = home
	paths.init()
	id = sessions.create({ cwd: home }).id
})
afterEach(async () => {
	await web.stop()
	host.reset()
	sessions.closeAll()
	changes.state.cache.clear()
	if (saved === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = saved
	rmSync(home, { recursive: true, force: true })
})
function blob(text: string): string {
	let hash = new Bun.CryptoHasher('sha256').update(text).digest('hex')
	mkdirSync(`${paths.sessionDir(id)}/file-blobs`, { recursive: true })
	writeFileSync(fileChanges.blobPath(id, hash), text)
	return hash
}

test('changes retain first/latest and steps through commits, exact content matches, and durable clear resets counts', async () => {
	await changes.run(['git', 'init', '-q', home])
	await changes.run(['git', 'config', 'user.name', 'Example'], home)
	await changes.run(['git', 'config', 'user.email', 'example@example.org'], home)
	let before = blob('old\n'), middle = blob('middle\n'), after = blob('+++ new\nnext\n')
	history.append(id, { type: 'file_changes', cwd: home, toolId: 'one', files: [{ path: 'a.txt', before, after: middle }] })
	history.append(id, { type: 'file_changes', cwd: home, toolId: 'two', files: [{ path: 'a.txt', before: middle, after }, { path: 'other', undeclared: true, statusBefore: null, statusAfter: '??' } as any] })
	let file = changes.list(id)[0]!
	expect(file.before).toBe(before)
	expect(file.after).toBe(after)
	expect(file.steps.map((s) => s.toolId)).toEqual(['one', 'two'])
	// Older histories' undeclared observations are ignored (c4x).
	expect(changes.list(id).map((f) => f.name)).toEqual(['a.txt'])
	expect(stats.of(id).files).toBe(1)
	let diff = await changes.diff(id, file.before, file.after)
	expect(diff).toContain('++++ new')
	expect(changes.counts(diff)).toBe('+2 -1')
	writeFileSync(`${home}/a.txt`, 'different\n')
	await changes.run(['git', 'add', 'a.txt'], home)
	expect((await changes.run(['git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Different content'], home)).code).toBe(0)
	expect(await changes.committed(id, file)).toBeUndefined()
	writeFileSync(`${home}/a.txt`, '+++ new\nnext\n')
	await changes.run(['git', 'add', 'a.txt'], home)
	expect((await changes.run(['git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Captured content'], home)).code).toBe(0)
	expect(await changes.committed(id, file)).toMatch(/^[a-f0-9]{8}$/)
	// Calls may observe temporary files outside their Git cwd.
	expect(await changes.committed(id, { ...file, path: `${home}-backup.txt` })).toBeUndefined()
	expect(changes.list(id)).toHaveLength(1)
	history.append(id, { type: 'command', text: '/changes clear' })
	expect(changes.list(id)).toHaveLength(0)
	expect(stats.of(id).files).toBeUndefined()
	expect(history.readSync(id).filter((r) => r.type === 'file_changes')).toHaveLength(2)
	history.append(id, { type: 'file_changes', cwd: home, toolId: 'three', files: [{ path: 'a.txt', before: after, after: null }] })
	expect(changes.list(id)[0]!.before).toBe(after)
})

test('diff routes require login, validate selection, escape content and show overlapping sessions and unavailable snapshots', async () => {
	let before = blob('old\n'), after = blob('<script>alert(1)</script>\n')
	history.append(id, { type: 'file_changes', cwd: home, toolId: 'call', files: [{ path: 'a.txt', before, after }, { path: '.env', before: null, after: { size: 8, mtime: 1 } }] })
	let other = sessions.create({ cwd: home, name: 'Neighbor' }).id
	history.append(other, { type: 'file_changes', cwd: home, toolId: 'other', files: [{ path: 'a.txt', before: null, after: blob('neighbor\n') }] })
	let server = {} as any
	let route = `http://localhost${changes.href(id)}`
	expect((await web.fetch(new Request(route), server))!.status).toBe(401)
	let token = webAuth.redeem(webAuth.issue())
	if (!('token' in token)) throw new Error('login failed')
	let response = await web.fetch(new Request(route, { headers: { cookie: `hal=${token.token}` } }), server)
	let html = await response!.text()
	expect(html).toContain('&#60;script&#62;')
	expect(html).not.toContain('<script>alert')
	expect(html).toContain(other)
	expect(html).toContain('metadata only')
	expect((await changesPage.serve(new URL(route + '?path=/etc/passwd'), web.css())).status).toBe(404)
})
