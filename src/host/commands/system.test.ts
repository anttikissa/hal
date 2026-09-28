import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { client, created, testHome, until, useHost } from '../host-fixture.test.ts'
import { clock } from '../clock.ts'
import { systemPrompt } from '../system-prompt.ts'

useHost()

test('/system names included source files and prints the same assembled prompt a provider request gets', async () => {
	let c = client()
	mkdirSync(`${testHome()}/repo/.git`, { recursive: true })
	writeFileSync(`${testHome()}/repo/AGENTS.md`, 'Stay in scope. <!-- literal -->')
	writeFileSync(`${testHome()}/extra.md`, 'Included text: ${model}')
	let orig = systemPrompt.file
	let now = clock.now
	try {
		systemPrompt.file = () => `${testHome()}/SYSTEM.md`
		writeFileSync(`${testHome()}/SYSTEM.md`, 'You are Hal.\n@extra.md\n::: if model="fake/*"\nSelected.\n:::')
		clock.now = () => Date.UTC(2026, 8, 28, 20)
		let id = created(c, `${testHome()}/repo`)
		c.conn.send({ type: 'submit', sessionId: id, text: '/system' })
		await until(() => c.of('output').at(-1)?.text?.includes('bytes total'))
		let output: string = c.of('output').at(-1).text
		for (let file of ['SYSTEM.md', 'extra.md', 'AGENTS.md']) expect(output).toMatch(new RegExp(`\\d+ bytes +[^\\n]*${file}`))
		let expected = systemPrompt.build({ cwd: `${testHome()}/repo`, model: 'fake/m1', now: clock.now(), sessionId: id })
		expect(output.slice(output.indexOf('\n\n') + 2)).toBe(expected)
		expect(output).toContain('Included text: ${model}')
		expect(output).toContain('Stay in scope. <!-- literal -->')
		writeFileSync(`${testHome()}/SYSTEM.md`, '::: if model="fake/*"\nUnclosed')
		c.conn.send({ type: 'submit', sessionId: id, text: '/system' })
		await until(() => c.of('output').at(-1)?.error)
		expect(c.of('output').at(-1).text).toMatch(/SYSTEM.md:1: unclosed/)
	} finally { systemPrompt.file = orig; clock.now = now }
})
