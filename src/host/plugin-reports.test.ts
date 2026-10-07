// Task njq: a disabled plugin is reported to the session whose bash call
// last declared and changed it; with no such call, to everyone, naming
// no session.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { history } from './history.ts'
import { calls, client, created, until, useHost } from './host-fixture.test.ts'
import { pluginReports } from './plugin-reports.ts'
import { plugins } from './plugins.ts'

useHost()
let failure = (path: string) => `plugin ${path} failed and was renamed to ${path}.broken, so it does not load again; Hal runs without it. Fix it and rename it back to x.ts to enable it.\nError: boom\n    at x.ts:1:7`

test('the session that last declared and changed the plugin gets the failure as a message', async () => {
	let c = client(), id = created(c, '/tmp/njq')
	history.append(id, { type: 'file_changes', toolId: 'toolu_x', call: 7, cwd: '/tmp/njq', files: [{ path: 'plugins/x.ts', before: null, after: 'a'.repeat(64) }] })
	await pluginReports.report(failure('/tmp/njq/plugins/x.ts'), '/tmp/njq/plugins/x.ts')
	await until(() => calls.length === 1)
	let text = JSON.stringify(calls[0]!.input.messages)
	expect(text).toContain('#t7 declared and changed /tmp/njq/plugins/x.ts')
	expect(text).toContain('Error: boom')
	expect(text).toContain('/tmp/njq/plugins/x.ts.broken')
	expect(c.of('warning')).toEqual([])
})

test('a plugin no session declared is a notice to every client, naming no session', async () => {
	let c = client(), id = created(c, '/tmp/njq')
	await pluginReports.report(failure('/tmp/njq/plugins/y.ts'), '/tmp/njq/plugins/y.ts')
	expect(calls).toHaveLength(0)
	let warning = c.of('warning').at(-1)!.text as string
	expect(warning).toContain('Error: boom')
	expect(warning).not.toContain(id)
})

// Task b66: after the initial scan, each lifecycle change is one notice
// naming the file; startup loads are quiet.
test('plugin load, reload and removal notify every client after a quiet startup', async () => {
	let c = client(), dir = mkdtempSync('/tmp/hal-b66-')
	plugins.changed = pluginReports.changed
	try {
		writeFileSync(join(dir, 'a.ts'), 'export default () => {}\n')
		await plugins.init(dir)
		expect(c.of('notice')).toEqual([])
		let b = join(dir, 'b.ts'), seen = (n: number) => until(() => c.of('notice').length === n)
		writeFileSync(b, 'export default () => {}\n')
		await seen(1)
		writeFileSync(b, 'export default () => () => {}\n')
		await seen(2)
		unlinkSync(b)
		await seen(3)
		expect(c.of('notice').map((n) => [n.name, n.what, n.line])).toEqual([['b.ts', 'loaded', b], ['b.ts', 'reloaded', b], ['b.ts', 'removed', b]])
	} finally {
		plugins.close()
		rmSync(dir, { recursive: true, force: true })
	}
})
