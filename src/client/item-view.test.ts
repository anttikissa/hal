import { expect, test } from 'bun:test'
import { strings } from '../common/strings.ts'
import { itemView } from './item-view.ts'

test('a divider is one row across the width, its text in it, even when too narrow', () => {
	for (let width of [80, 41, 10]) {
		let rows = itemView.itemLines({ type: 'divider', text: 'context compacted (2 prompts summarised)' }, width)
		expect(rows.length).toBe(1)
		expect(strings.visLen(rows[0]!)).toBe(width)
	}
	expect(itemView.itemLines({ type: 'divider', text: 'context cleared' }, 40)[0]).toMatch(/^─+ context cleared ─+$/)
})
