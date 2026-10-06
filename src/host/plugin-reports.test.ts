// Task njq: a disabled plugin is reported to the session whose bash call
// last declared and changed it; with no such call, to everyone, naming
// no session.
import { expect, test } from 'bun:test'
import { history } from './history.ts'
import { calls, client, created, until, useHost } from './host-fixture.test.ts'
import { pluginReports } from './plugin-reports.ts'

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
