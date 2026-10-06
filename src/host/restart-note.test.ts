import { afterEach, beforeEach, expect, test } from 'bun:test'
import { useHost } from './host-fixture.test.ts'
import { history } from './history.ts'
import { restartNote } from './restart-note.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { busy } from './busy.ts'
import { liveFiles } from './live-file.ts'

useHost()
beforeEach(() => Object.assign(restartNote.state, { written: false, text: undefined, until: 0, errors: [] }))
afterEach(() => Object.assign(restartNote.state, { written: false, text: undefined, until: 0, errors: [] }))

function openTab(): string {
	let id = sessions.create({ cwd: '/tmp', model: 'fake/m' }).id
	tabs.file().open.push(id)
	return id
}

test('first startup is not a restart; deliberate restart reaches restored tabs before their next request', async () => {
	restartNote.started('version-a')
	expect(restartNote.pending()).toBeUndefined()
	let id = openTab()
	let closed = sessions.create({ cwd: '/tmp', model: 'fake/m' }).id
	restartNote.write('tab 3 (/restart host)')
	restartNote.started('version-b')
	let notice = history.readSync(id).find((r) => r.type === 'notice')!
	let text = notice.text
	expect(text).toContain('Hal restarted by tab 3 (/restart host)')
	expect(text).toContain('version-b (previous host: version-a)')
	expect(history.readSync(closed)).toEqual([])
	expect(busy.list()).not.toContain(id)
	let first = await history.messages(id)
	expect(JSON.stringify(first)).toContain('version-b (previous host: version-a)')
	expect(await history.messages(id)).toEqual(first)
})

test('unattributed startup reports unknown cause and same loaded version honestly', () => {
	restartNote.started('same-version')
	let id = openTab()
	restartNote.started('same-version')
	let notice = history.readSync(id).find((r) => r.type === 'notice')!
	let text = notice.text
	expect(text).toContain('restart cause unknown')
	expect(text).toContain('same-version (previous host: same-version)')
	let stamp = restartNote.read()
	expect(stamp.text).toBeUndefined()
	liveFiles.close(stamp)
})

test('one unreadable open tab does not prevent startup notices for healthy tabs', () => {
	restartNote.started('v1')
	let id = openTab()
	tabs.file().open.unshift('missing-tab')
	restartNote.started('v2')
	expect(history.readSync(id).some((record) => record.type === 'notice')).toBe(true)
	expect(restartNote.state.errors).toHaveLength(1)
	expect(restartNote.state.errors[0]).toContain('missing-tab')
})
