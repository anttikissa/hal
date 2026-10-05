import { expect, test } from 'bun:test'
import { lstatSync, readlinkSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { colors } from '../../common/colors.ts'
import { plugins } from '../plugins.ts'
import { client, created, until, useHost } from '../host-fixture.test.ts'

useHost()

test('/theme links a theme as the color plugin, and hal, the built-in, removes it', async () => {
	let a = client()
	let id = created(a)
	let say = async (text: string) => {
		let n = a.of('output').length
		a.conn.send({ type: 'submit', sessionId: id, text })
		await until(() => a.of('output').length > n)
		return a.of('output').at(-1)!
	}
	let link = join(plugins.dir(), 'color-theme.ts')
	let canvas = colors.page().canvas
	let theme = async () => {
		let n = a.of('question').length
		a.conn.send({ type: 'submit', sessionId: id, text: '/theme' })
		await until(() => a.of('question').length > n)
		return a.of('question').at(-1)!.form.fields[0] as { options: string[]; initial: number }
	}
	let field = await theme()
	expect(field.options).toContain('wopr')
	expect(field.options[field.initial]).toBe('hal')
	// Answering the question switches, like /theme <name>.
	let n = a.of('output').length
	a.conn.send({ type: 'answer', sessionId: id, question: a.of('question').at(-1)!.id, answers: { theme: 'nostromo' } })
	await until(() => a.of('output').length > n)
	expect(a.of('output').at(-1)!.error).toBeFalsy()
	expect(realpathSync(link)).toBe(realpathSync(join(import.meta.dir, '../../../themes/nostromo.ts')))
	expect(readlinkSync(link).startsWith('/')).toBe(false)
	field = await theme()
	expect(field.options[field.initial]).toBe('nostromo')
	// The plugin loader applies it and, once removed, puts colors back.
	await plugins.init()
	try {
		await until(() => colors.page().canvas?.join() !== canvas?.join())
		await say('/theme tron')
		expect(realpathSync(link)).toContain('tron.ts')
		await say('/theme hal')
		expect(() => lstatSync(link)).toThrow()
		await until(() => colors.page().canvas?.join() === canvas?.join())
	} finally {
		plugins.close()
	}
	let nope = await say('/theme nope')
	expect(nope.error).toBe(true)
	expect(nope.text).toContain('nostromo')
	// A color-theme.ts of the user's own is never replaced.
	writeFileSync(link, '// mine\nexport default () => {}\n')
	try {
		expect((await say('/theme tron')).text).toContain('own file')
		expect(readFileSync(link, 'utf8')).toContain('mine')
	} finally {
		rmSync(link)
	}
})
