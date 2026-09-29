import { expect, test } from 'bun:test'
import { client, created, useHost } from '../host-fixture.test.ts'
import { tools } from '../tools.ts'
import { tabs } from '../tabs.ts'
import { models } from '../models.ts'
import { provider } from '../provider.ts'

useHost()

const inspect = (sessionId: string, input: Record<string, unknown> = {}) => tools.run(
	{ type: 'tool_call', id: 'i', name: 'inspect', input },
	{ cwd: '/tmp', signal: new AbortController().signal, sessionId },
)

test('shows tabs in their shared order, identifies caller, live state and clients without disclosing addresses', async () => {
	let a = client()
	let first = created(a, '/tmp/first')
	let b = client()
	let second = created(b, '/tmp/second')
	// A created session is not automatically a tab; the tab bar is the source of truth.
	tabs.file().open.push(second, first)
	let result = await inspect(first)
	expect(result.isError).toBeUndefined()
	expect(result.output).toMatch(/Clients: 2/)
	expect(result.output.indexOf(second)).toBeLessThan(result.output.indexOf(first))
	expect(result.output).toContain(`${first} (you)`)
	expect(result.output).toContain('/tmp/first')
	expect(result.output).toContain('idle')
	expect(result.output).toMatch(/Host PID \d+; version .+; started .*; uptime \d+s/)
	expect(result.output).not.toContain('token')
	// The default view is also offered by name, so a model can see it exists.
	expect((await inspect(first, { view: 'tabs' })).output).toContain(`${first} (you)`)
	expect(JSON.stringify(tools.defs().find((t) => t.name === 'inspect')?.inputSchema)).toContain('"tabs"')
})

test('model view groups registered providers and marks configured default', async () => {
	let c = client()
	let id = created(c)
	let previous = provider.state.providers
	try {
		provider.state.providers = { sample: { request: () => ({ url: '', headers: {}, body: '' }), parse: async function* () {}, known: () => ['alpha', 'beta'] } }
		let result = await inspect(id, { view: 'models' })
		expect(result.output).toContain(`Default: ${models.defaultModel()}`)
		expect(result.output).toContain('hal: hal/intro')
		expect(result.output).toContain('sample: sample/alpha, sample/beta')
		expect((await inspect(id, { view: 'sessions' })).isError).toBe(true)
	} finally { provider.state.providers = previous }
})
