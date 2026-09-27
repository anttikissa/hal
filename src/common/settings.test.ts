import { afterEach, expect, test } from 'bun:test'
import { settings } from './settings.ts'

afterEach(() => {
	settings.state.raw = {}
})

function defaults(): Record<string, unknown> {
	return settings.check({}).values
}

test('an empty file means every declared default and no warnings', () => {
	let { values, warnings } = settings.check({})
	expect(warnings).toEqual([])
	for (let s of settings.table) expect(values[s.name]).toEqual(s.default)
})

test('every declared default passes its own validation', () => {
	let all = Object.fromEntries(settings.table.map((s) => [s.name, s.default]))
	expect(settings.check(all).warnings).toEqual([])
})

test('valid values are taken', () => {
	let { values, warnings } = settings.check({ model: 'openai/gpt-5', security: 'none', webPort: 8080, promptRows: 4, pasteLines: 20, maxRounds: 50 })
	expect(warnings).toEqual([])
	expect(values).toEqual({ model: 'openai/gpt-5', security: 'none', webPort: 8080, promptRows: 4, pasteLines: 20, maxRounds: 50 })
})

test('an unknown key is a warning and changes nothing else', () => {
	let { values, warnings } = settings.check({ modle: 'x/y', webPort: 8080 })
	expect(warnings.length).toBe(1)
	expect(warnings[0]).toContain('modle')
	expect(values).toEqual({ ...defaults(), webPort: 8080 })
})

test('a bad value warns and only that setting falls back to its default', () => {
	for (let bad of [{ security: 'paranoid' }, { webPort: 'x' }, { webPort: 70000 }, { webPort: 80.5 }, { model: 3 }, { model: '' }]) {
		let key = Object.keys(bad)[0]!
		let { values, warnings } = settings.check({ ...bad, promptRows: 4 })
		expect(warnings.length).toBe(1)
		expect(warnings[0]).toContain(key)
		expect(values).toEqual({ ...defaults(), promptRows: 4 })
	}
})

test('getters read the current raw settings at call time', () => {
	let before = settings.model()
	settings.state.raw = { model: 'test/now' }
	expect(settings.model()).toBe('test/now')
	settings.state.raw.model = 'test/later'
	expect(settings.model()).toBe('test/later')
	settings.state.raw = { model: 42 }
	expect(settings.model()).toBe(before)
	expect(settings.warnings()[0]).toContain('model')
})
