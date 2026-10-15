// Plugin failures notify the last declared editor, or the shared notice
// area and history without adding errors to unrelated transcripts.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { history } from './history.ts'
import { calls, client, created, until, useHost } from './host-fixture.test.ts'
import { pluginReports } from './plugin-reports.ts'
import { noticeHistory } from './notice-history.ts'
import { plugins } from './plugins.ts'

useHost()
let failure = (path: string) => `plugin ${path} failed and was renamed to ${path}.broken, so it does not load again; Hal runs without it. Fix it and rename it back to x.ts to enable it.\nError: boom\n    at x.ts:1:7`

test('the session that last declared and changed the plugin gets the failure as a message', async () => {
	let c = client(), id = created(c, '/tmp/njq')
	history.append(id, { type: 'file_changes', toolId: 'toolu_x', call: 7, cwd: '/tmp/njq', files: [{ path: 'plugins/x.ts', before: null, after: 'a'.repeat(64) }] })
	await pluginReports.report(failure('/tmp/njq/plugins/x.ts'), '/tmp/njq/plugins/x.ts')
	await until(() => calls.length === 1)
	let text = JSON.stringify(calls[0]!.input.messages)
	expect(text).toContain('t7 declared and changed /tmp/njq/plugins/x.ts')
	expect(text).toContain('Error: boom')
	expect(text).toContain('/tmp/njq/plugins/x.ts.broken')
	expect(c.of('notice')).toEqual([])
})

test('an unidentified plugin failure reaches notices without changing any session history', async () => {
	let c = client(), id = created(c, '/tmp/njq'), other = created(c, '/tmp/njq')
	let before = [history.readSync(id), history.readSync(other)]
	let text = failure('/tmp/njq/plugins/y.ts')
	await pluginReports.report(text, '/tmp/njq/plugins/y.ts')
	expect(calls).toHaveLength(0)
	expect([history.readSync(id), history.readSync(other)]).toEqual(before)
	expect(c.of('warning')).toEqual([])
	expect(c.of('notice')).toEqual([{ type: 'notice', session: '', name: 'Plugins', kind: 'failed', line: text, key: 'plugin:failure' }])
	expect(noticeHistory.list()[0]).toMatchObject({ session: '', kind: 'failed', line: text })
})

// Task b66: after the initial scan, each lifecycle change is one notice
// naming the file; startup loads are quiet.
test('plugin load, sync replacement and removal notify every client after a quiet startup', async () => {
	let c = client(), dir = mkdtempSync('/tmp/hal-b66-')
	plugins.changed = pluginReports.changed
	try {
		writeFileSync(join(dir, 'a.ts'), 'export default () => {}\n')
		await plugins.init(dir)
		expect(c.of('notice')).toEqual([])
		let b = join(dir, 'b.ts'), seen = (n: number) => until(() => c.of('notice').length === n)
		writeFileSync(b, 'export default () => {}\n')
		await seen(1)
		pluginReports.via(b, 'server example.com', 'client')
		writeFileSync(b, 'export default () => () => {}\n')
		await seen(2)
		unlinkSync(b)
		await seen(3)
		expect(c.of('notice').map((n) => [n.name, n.what, n.line])).toEqual([['b.ts', 'loaded', b], ['b.ts', 'replaced', `${b} on client from server example.com`], ['b.ts', 'removed', b]])
	} finally {
		plugins.close()
		rmSync(dir, { recursive: true, force: true })
	}
})
