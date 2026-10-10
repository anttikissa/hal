import { expect, test } from 'bun:test'
import { settings } from '../common/settings.ts'
import { itemView } from './item-view.ts'

test('an image block’s label links to the image', () => {
	let item = { type: 'image', blob: 'abc123def456', mediaType: 'image/png', bytes: 27000, key: '~0' } as const
	let url = `http://localhost:${settings.webPort()}/blob/s-1/abc123def456`
	expect(itemView.itemLines(item as any, 60, false, 's-1')).toEqual([`\x1b]8;;${url}\x07[image 27 kB png]\x1b]8;;\x07`])
	expect(itemView.itemLines(item as any, 60)).toEqual(['[image 27 kB png]'])
})

test('answers with only hidden controls or whitespace have no terminal card', () => {
	for (let text of ['', ' \n\t', '<summary></summary>', '<rename>New name</rename>']) {
		let item = { type: 'text', text, key: '12', ts: '2026-10-06T22:09:00Z', model: 'fake/model' } as const
		for (let fold of ['open', 'closed'] as const) {
			expect(itemView.itemLines(item, 60, false, 's-1', undefined, undefined, [], { fold })).toEqual([])
			expect(itemView.itemLines(item, 60, true, 's-1', undefined, undefined, [], { fold })).toEqual([''])
		}
	}
	let item = { type: 'text', text: '<summary>Stopped.</summary>' } as const
	let rows = itemView.itemLines(item, 60)
	expect(rows.join('\n')).toContain('Stopped.')
	expect(rows.join('\n')).not.toContain('<summary>')
	// Literal markup in code is content, not a hidden control.
	expect(itemView.itemLines({ type: 'text', text: '`<summary>Stopped.</summary>`' }, 60).length).toBeGreaterThan(0)
})

test('tool errors without exit codes or timings remain visible in the title status', () => {
	let error = { output: 'Error: malformed arguments', isError: true }
	let status = (item: typeof error & { interrupted?: 'canceled' | 'stopped' }, bash = false) => Bun.stripANSI(itemView.resultStatus(item, bash, undefined))
	expect(status(error)).toBe('(failed)')
	expect(status(error, true)).toBe('(failed)')
	expect(status({ ...error, output: '[exit 2]\ncommand failed' }, true)).toBe('(exit 2)')
	expect(status({ ...error, interrupted: 'canceled' })).toBe('(canceled)')
	expect(status({ output: 'Success', isError: false })).toBe('')
})

test('interrupted text decorates its end, preserving trailing spaces and line breaks', () => {
	for (let [text, end] of [['partial', 'partial --'], ['partial ', 'partial --'], ['partial\n', 'partial\n--'], ['', '--']] as const) {
		let item = { type: 'text' as const, text: text!, interrupted: true as const }
		let rows = itemView.itemLines(item, 60)
		let plain = rows.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
		expect(plain.endsWith(end!)).toBe(true)
		expect(item.text).toBe(text)
	}
})
