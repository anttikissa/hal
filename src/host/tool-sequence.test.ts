import { expect, spyOn, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { nativeTool } from './native-tool.ts'
import { history } from './history.ts'
import { fileText } from './file-text.ts'
import { tools } from './tools.ts'
import { calls, client, created, fresh, testHome, until, useHost } from './host-fixture.test.ts'

useHost()

const expand = (cmd: string) => nativeTool.expand({ type: 'tool_call', id: 'compound', name: 'tool', input: { cmd } })

test('compound calls split only between complete top-level commands', () => {
	let commands = ['EDIT a.txt create\n!!NEW\nfirst\nBASH ls\nlast\n!!END', 'EDIT /* keep\nREAD inside comment */\na.txt@abcde replace 1-1\n!!NEW\nREAD b.txt\n!!END', 'bash ls', 'BASH "ls -l"']
	let members = expand(commands.join('\n'))
	expect(members.map((c) => c.cmd)).toEqual(commands)
	expect(members.map((c) => c.name)).toEqual(['edit', 'edit', 'bash', 'bash'])
	expect(members[0]!.input.edits).toEqual([{ path: 'a.txt', new: 'first\nBASH ls\nlast\n', create: true }])
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
		calls[0]!.push({ type: 'tool_call', id: 'compound', name: 'tool', input: { cmd: 'EDIT order.txt create\n!!NEW\nfirst\n!!END\nBASH "printf second >> order.txt"\nBASH "printf third >> order.txt"\nREAD order.txt' } }, { type: 'done', reason: 'tool_use' })
		await until(() => started.length > 0)
		expect(started).toEqual(['edit'])
		gate.resolve()
		await until(() => calls.length === 2)
		expect(started).toEqual(['edit', 'bash', 'bash', 'read'])
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
	await until(() => history.readSync(id).some((r) => r.type === 'change' && r.model === 'hal/tool'))
	for (let path of ['a.txt', 'b.txt']) writeFileSync(`${testHome()}/${path}`, 'old\n')
	let hash = fileText.hash(Buffer.from('old\n'))
	let cmd = `EDIT\na.txt@${hash} replace 1-1\n!!NEW\nnew a\n!!END\nEDIT\nb.txt@${hash} replace 1-1\n!!NEW\nnew b\n!!END\nREAD missing.txt\nREAD a.txt`
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

test.each(['provider', 'hal/tool'])('%s read-only batches run concurrently and retain result order', async (mode) => {
	let c = client(), id = created(c, testHome())
	for (let path of ['a.txt', 'b.txt']) writeFileSync(`${testHome()}/${path}`, path + '\n')
	if (mode === 'hal/tool') {
		c.conn.send({ type: 'submit', sessionId: id, text: '/model hal/tool' })
		await until(() => history.readSync(id).some((r) => r.type === 'change' && r.model === 'hal/tool'))
	}
	let gate = Promise.withResolvers<void>(), started: unknown[] = []
	let original = tools.run
	let spy = spyOn(tools, 'run').mockImplementation(async (call, ctx) => {
		started.push(call.input.path)
		if (call.input.path === 'a.txt') await gate.promise
		return original(call, ctx)
	})
	try {
		let cmd = 'READ a.txt\nREAD b.txt'
		c.conn.send({ type: 'submit', sessionId: id, text: mode === 'hal/tool' ? cmd : 'go' })
		if (mode === 'provider') {
			await until(() => calls.length === 1)
			calls[0]!.push({ type: 'tool_call', id: 'compound', name: 'tool', input: { cmd } }, { type: 'done', reason: 'tool_use' })
		}
		await until(() => started.length === 2)
		expect(started).toEqual(['a.txt', 'b.txt'])
		gate.resolve()
		if (mode === 'provider') {
			await until(() => calls.length === 2)
			calls[1]!.push({ type: 'done', reason: 'end' })
		}
		await until(() => c.of('turn-end').length)
		let records = history.readSync(id)
		let invoked = records.flatMap((r) => r.type === 'assistant' && r.block.type === 'tool_call' ? [r.block] : [])
		let results = records.flatMap((r) => r.type === 'user' ? r.blocks.filter((b) => b.type === 'tool_result') : [])
		expect(results.map((r) => r.id)).toEqual(invoked.map((b) => b.id))
		expect(results.map((r) => r.output.split('\n')[1])).toEqual(['1: a.txt', '1: b.txt'])
	} finally { gate.resolve(); spy.mockRestore() }
})

test.each(['bash', 'command', 'unregistered'])('%s makes the whole compound batch sequential', async (name) => {
	let members = expand('READ a\nREAD b\nBASH true\nREAD c\nREAD d')
	members[2] = { ...members[2]!, name, input: name === 'command' ? { command: '/rename changed' } : {} }
	let gate = Promise.withResolvers<void>(), first = Promise.withResolvers<void>(), started: string[] = []
	let pending = tools.round(members, { cwd: testHome(), sessionId: 'batch' }, async (call) => {
		started.push(call.name)
		if (started.length === 1) { first.resolve(); await gate.promise }
		return { type: 'tool_result', id: call.id, output: String(started.length) }
	})
	try {
		await first.promise
		expect(started).toEqual(['read'])
	} finally { gate.resolve(); await pending }
	expect(started).toEqual(['read', 'read', name, 'read', 'read'])
})

test('read-only batches defer WAIT until other round work settles', async () => {
	let members = [...expand('WAIT\nREAD a'), { type: 'tool_call' as const, id: 'other', name: 'bash', input: { command: 'true' } }]
	let gate = Promise.withResolvers<void>(), other = Promise.withResolvers<void>(), started: string[] = []
	let pending = tools.round(members, { cwd: testHome(), sessionId: 'batch' }, async (call) => {
		started.push(call.name)
		if (call.id === 'other') { other.resolve(); await gate.promise }
		return { type: 'tool_result', id: call.id, output: call.name }
	})
	try {
		await other.promise
		expect(started).toEqual(['read', 'bash'])
	} finally { gate.resolve() }
	let results = await pending
	expect(started).toEqual(['read', 'bash', 'wait'])
	expect(results.map((r) => r.output)).toEqual(['wait', 'read', 'bash'])
})
