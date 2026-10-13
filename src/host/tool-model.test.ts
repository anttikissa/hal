import { expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { history } from './history.ts'
import { calls, client, created, fresh, testHome, until, useHost } from './host-fixture.test.ts'
import { greetings } from './greetings.ts'
import { sessions } from './sessions.ts'
import { toolModel } from './tool-model.ts'

useHost(false, true)

test('direct tool mode welcomes, executes each command once and preserves parser errors', async () => {
	let c = client(), id = created(c, testHome())
	c.conn.send({ type: 'submit', sessionId: id, text: '/model hal/tool' })
	await until(() => history.readSync(id).some((r) => r.type === 'output' && r.text.includes(toolModel.welcome)))
	expect(sessions.open(id).blocks).toEqual(sessions.toolBlocks)
	writeFileSync(`${testHome()}/example.txt`, 'hello')
	for (let [index, text] of ['BASH ls', 'NO_SUCH_TOOL', 'HELP BASH'].entries()) {
		c.conn.send({ type: 'submit', sessionId: id, text })
		await until(() => c.of('turn-end').length === index + 1)
	}
	let records = history.readSync(id)
	let tools = records.filter((r) => r.type === 'assistant' && r.block.type === 'tool_call')
	expect(tools).toHaveLength(3)
	expect(tools[0]).toMatchObject({ block: { name: 'bash', input: { command: 'ls' }, cmd: 'BASH ls' } })
	let results = records.flatMap((r) => r.type === 'user' ? r.blocks.filter((b) => b.type === 'tool_result') : [])
	expect(results).toHaveLength(3)
	expect(results[0]?.output).toContain('example.txt')
	expect(results[1]).toMatchObject({ isError: true })
	expect(results[1]?.output).toContain('NO_SUCH_TOOL')
	expect(results[2]?.output).toContain('BASH')
	expect(toolModel.run(records, id)).toEqual({})
	expect(calls).toHaveLength(0)
	expect((await fresh(id)).items).toEqual(c.views.get(id)!.items)
})

test('clear and unchanged model selection show instructions before the next tool command', async () => {
	let c = client(), id = created(c, testHome())
	c.conn.send({ type: 'submit', sessionId: id, text: '/model hal/tool' })
	let welcomes = () => history.readSync(id).filter((r) => r.type === 'output' && r.text.includes(toolModel.welcome)).length
	await until(() => welcomes() === 1)
	c.conn.send({ type: 'submit', sessionId: id, text: 'BASH "echo before"' })
	await until(() => c.of('turn-end').length === 1)
	c.conn.send({ type: 'submit', sessionId: id, text: '/clear' })
	await until(() => welcomes() === 2)
	let records = history.readSync(id)
	expect(records.findLastIndex((r) => r.type === 'output' && r.text.includes(toolModel.welcome))).toBeGreaterThan(records.findLastIndex((r) => r.type === 'reset'))
	c.conn.send({ type: 'submit', sessionId: id, text: '/model hal/tool' })
	await until(() => welcomes() === 3)
	c.conn.send({ type: 'submit', sessionId: id, text: 'BASH "echo ready"' })
	await until(() => c.of('turn-end').length === 2)
	expect(history.readSync(id).filter((r) => r.type === 'assistant' && r.block.type === 'tool_call')).toHaveLength(2)
	expect(welcomes()).toBe(3)
	expect(calls).toHaveLength(0)
	expect((await fresh(id)).items).toEqual(c.views.get(id)!.items)
})

test('empty direct-tool sessions get a durable welcome without consuming a command', () => {
	let id = sessions.create({ cwd: testHome(), model: 'hal/tool' }).id
	greetings.open(id)
	greetings.open(id)
	expect(history.readSync(id)).toHaveLength(1)
	expect(history.readSync(id)[0]).toMatchObject({ type: 'output', text: toolModel.welcome, synthetic: true })
	expect(toolModel.run(history.readSync(id), id)).toEqual({ say: toolModel.welcome })
})
