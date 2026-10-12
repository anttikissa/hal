import { expect, spyOn, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { nativeTool } from './native-tool.ts'
import { history } from './history.ts'
import { lease } from './lease.ts'
import { tools } from './tools.ts'
import { calls, client, created, fresh, testHome, until, useHost } from './host-fixture.test.ts'

useHost()

const expand = (cmd: string) => nativeTool.expand({ type: 'tool_call', id: 'compound', name: 'tool', input: { cmd } })

test('compound calls split only between complete top-level commands', () => {
	let commands = ['WRITE "a.txt" `first\nBASH ls\nlast`', 'EDIT /* keep\nREAD inside comment */ "a.txt@abcde" {\n range: 1, lines: ["READ b.txt"]\n}', 'bash ls', 'BASH "ls -l"']
	let members = expand(commands.join('\n'))
	expect(members.map((c) => c.cmd)).toEqual(commands)
	expect(members.map((c) => c.name)).toEqual(['write', 'edit', 'bash', 'bash'])
	expect(members[0]!.input.content).toBe('first\nBASH ls\nlast')
	expect(new Set(members.map((c) => c.id)).size).toBe(4)
	expect(members.every((c) => c.sequence === 'compound')).toBe(true)
	for (let tail of ['NO_SUCH_TOOL x', 'BASH "ls" { evil: true }', 'BASH "unclosed']) {
		let cmd = 'BASH ls\n' + tail
		expect(expand(cmd)).toMatchObject([{ name: 'tool', input: { cmd } }])
		expect(() => nativeTool.multiple(cmd)).toThrow()
	}
})

test('provider compound calls run sequentially and replay every result with its own call', async () => {
	let c = client(), id = created(c, testHome())
	let gate = Promise.withResolvers<void>(), started: string[] = []
	let original = tools.run
	let spy = spyOn(tools, 'run').mockImplementation(async (call, ctx) => {
		started.push(call.name)
		if (started.length === 1) await gate.promise
		return original(call, ctx)
	})
	try {
		c.conn.send({ type: 'submit', sessionId: id, text: 'go' })
		await until(() => calls.length === 1)
		calls[0]!.push({ type: 'tool_call', id: 'compound', name: 'tool', input: { cmd: 'WRITE "order.txt" "first\\n"\nBASH "printf second >> order.txt"\nBASH "printf third >> order.txt"\nREAD order.txt' } }, { type: 'done', reason: 'tool_use' })
		await until(() => started.length > 0)
		expect(started).toEqual(['write'])
		gate.resolve()
		await until(() => calls.length === 2)
		expect(started).toEqual(['write', 'bash', 'bash', 'read'])
		expect(readFileSync(`${testHome()}/order.txt`, 'utf8')).toBe('first\nsecondthird')
		let messages = calls[1]!.input.messages.flatMap((m: any) => m.blocks)
		let invoked = messages.filter((b: any) => b.type === 'tool_call')
		let results = messages.filter((b: any) => b.type === 'tool_result')
		expect(invoked).toHaveLength(4)
		expect(results.map((r: any) => r.id)).toEqual(invoked.map((b: any) => b.id))
		expect(results.at(-1).output).toContain('secondthird')
		expect(results.some((r: any) => r.isError)).toBe(false)
		calls[1]!.push({ type: 'done', reason: 'end' })
		await until(() => c.of('turn-end').length)
		expect((await fresh(id)).items).toEqual(c.views.get(id)!.items)
	} finally { gate.resolve(); spy.mockRestore() }
})

test('direct mode accepts multiple EDITs and preserves runtime errors without dropping later calls', async () => {
	let c = client(), id = created(c, testHome())
	c.conn.send({ type: 'submit', sessionId: id, text: '/model hal/tool' })
	await until(() => history.readSync(id).some((r) => r.type === 'output' && r.text.includes('Direct tool mode')))
	for (let path of ['a.txt', 'b.txt']) writeFileSync(`${testHome()}/${path}`, 'old\n')
	let hash = lease.hash(Buffer.from('old\n'))
	let cmd = `EDIT "a.txt@${hash}" { range: 1, lines: ["new a"] }\nEDIT "b.txt@${hash}" { range: 1, lines: ["new b"] }\nREAD missing.txt\nREAD a.txt`
	c.conn.send({ type: 'submit', sessionId: id, text: cmd })
	await until(() => c.of('turn-end').length)
	expect(readFileSync(`${testHome()}/a.txt`, 'utf8')).toBe('new a\n')
	expect(readFileSync(`${testHome()}/b.txt`, 'utf8')).toBe('new b\n')
	let results = history.readSync(id).flatMap((r) => r.type === 'user' ? r.blocks.filter((b) => b.type === 'tool_result') : [])
	expect(results).toHaveLength(4)
	expect(results[2]).toMatchObject({ isError: true })
	expect(results[2]!.output).toContain('missing.txt')
	expect(results[3]!.output).toContain('new a')
})
