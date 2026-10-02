import { expect, test } from 'bun:test'
import { completion } from '../../common/completion.ts'
import { commands } from '../commands.ts'

const ctx = { sessionId: 's', cwd: '/tmp', model: 'fake/m', setCwd() {}, setModel() {}, say() {} }

test('restart exposes described scopes but explicit completion fills its default, not a partial command', () => {
	for (let input of ['/restart', '/restart ', '/restart  ']) {
		let { items, descriptions } = commands.suggestions(input, ctx)
		expect(items).toEqual(['/restart local', '/restart host', '/restart both', '/restart all'])
		expect(descriptions?.[0]).toContain('(default)')
		expect(descriptions?.every((d) => d.includes('restart') && d !== 'path')).toBe(true)
		expect(completion.apply(input, items).text).toBe('/restart local')
	}
	expect(completion.apply('/rest', commands.complete('/rest', ctx)).text).toBe('/restart ')
	expect(completion.apply('/restart h', commands.complete('/restart h', ctx)).text).toBe('/restart host')
	// Never manufacture a replacement absent from the host response.
	expect(completion.apply('/restart', []).text).toBe('/restart')
	expect(completion.apply('/cd', commands.complete('/cd', ctx)).text).toBe('/cd ')
})
