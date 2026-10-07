import { expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { colors } from '../../common/colors.ts'
import { plugins } from '../plugins.ts'
import { theme } from './theme.ts'
import { client, created, until, useHost } from '../host-fixture.test.ts'

useHost()

const themes = join(import.meta.dir, '../../../themes')
const file = () => join(plugins.dir(), 'theme.ts')
const link = () => join(plugins.dir(), 'color-theme.ts')
const selected = () => readFileSync(file(), 'utf8').match(/themes\/(\w+)\.ts'/)?.[1]

function session() {
	let a = client()
	let id = created(a)
	let say = async (text: string) => {
		let n = a.of('output').length
		a.conn.send({ type: 'submit', sessionId: id, text })
		await until(() => a.of('output').length > n)
		return a.of('output').at(-1)!
	}
	return { a, id, say }
}

test('/theme writes a portable selector the loader applies live; hal, the built-in, removes it', async () => {
	let { a, id, say } = session()
	let canvas = colors.page().canvas
	let ask = async () => {
		let n = a.of('question').length
		a.conn.send({ type: 'submit', sessionId: id, text: '/theme' })
		await until(() => a.of('question').length > n)
		return a.of('question').at(-1)!.form.fields[0] as { options: string[]; initial: number }
	}
	let field = await ask()
	expect(field.options).toContain('wopr')
	expect(field.options[field.initial]).toBe('hal')
	// Answering the question switches, like /theme <name>.
	let n = a.of('output').length
	a.conn.send({ type: 'answer', sessionId: id, question: a.of('question').at(-1)!.id, answers: { theme: 'nostromo' } })
	await until(() => a.of('output').length > n)
	expect(a.of('output').at(-1)!.error).toBeFalsy()
	let text = readFileSync(file(), 'utf8')
	expect(text).toContain('export const portable = true\n')
	expect(text).toContain(`export { default } from '${relative(realpathSync(plugins.dir()), realpathSync(themes))}/nostromo.ts'\n`)
	field = await ask()
	expect(field.options[field.initial]).toBe('nostromo')
	await plugins.init()
	try {
		await until(() => colors.page().canvas?.join() !== canvas?.join())
		let nostromo = colors.page().canvas?.join()
		await say('/theme tron')
		expect(selected()).toBe('tron')
		await until(() => colors.page().canvas?.join() !== nostromo)
		await say('/theme hal')
		expect(existsSync(file())).toBe(false)
		await until(() => colors.page().canvas?.join() === canvas?.join())
	} finally {
		plugins.close()
	}
	let nope = await say('/theme nope')
	expect(nope.error).toBe(true)
	expect(nope.text).toContain('nostromo')
})

test('a color-theme.ts link into themes/ becomes theme.ts with the same theme, leaving the target alone', async () => {
	mkdirSync(plugins.dir(), { recursive: true })
	let target = join(themes, 'wopr.ts')
	let before = readFileSync(target, 'utf8')
	symlinkSync(relative(realpathSync(plugins.dir()), realpathSync(target)), link())
	expect(theme.active().name).toBe('wopr')
	theme.migrate()
	expect(() => lstatSync(link())).toThrow()
	expect(selected()).toBe('wopr')
	expect(readFileSync(target, 'utf8')).toBe(before)
	rmSync(file())
})

test('/theme never replaces a custom theme.ts or an unknown symlink', async () => {
	let { say } = session()
	mkdirSync(plugins.dir(), { recursive: true })
	writeFileSync(file(), '// mine\nexport default () => {}\n')
	let out = await say('/theme tron')
	expect(out.error).toBe(true)
	expect(out.text).toContain('own file')
	expect(readFileSync(file(), 'utf8')).toContain('mine')
	rmSync(file())
	let elsewhere = join(plugins.dir(), 'elsewhere.txt')
	writeFileSync(elsewhere, 'x')
	symlinkSync('elsewhere.txt', file())
	expect((await say('/theme hal')).text).toContain('symlink')
	expect(lstatSync(file()).isSymbolicLink()).toBe(true)
	rmSync(file())
	rmSync(elsewhere)
})

test('a selector naming a missing theme reports its load error and selects nothing else', async () => {
	mkdirSync(plugins.dir(), { recursive: true })
	writeFileSync(file(), "export const portable = true\nexport { default } from '../themes/nope.ts'\n")
	let canvas = colors.page().canvas
	let reports: string[] = []
	let report = plugins.report
	plugins.report = (text) => void reports.push(text)
	try {
		await plugins.init()
		await until(() => reports.length > 0)
		expect(reports.join('\n')).toContain('nope.ts')
		expect(colors.page().canvas).toEqual(canvas)
	} finally {
		plugins.close()
		plugins.report = report
		for (let f of [file(), `${file()}.broken`]) rmSync(f, { force: true })
	}
})
