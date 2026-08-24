import { expect, test } from 'bun:test'
import { webStatus } from './status.ts'

test('crams session, directory, model and context into one line', () => {
	const text = webStatus.text(
		{ id: '05-fit', name: 'Web status line', cwd: '/root/hal', model: 'anthropic/claude-opus-4-6' },
		{ id: '05-fit', createdAt: '', context: { used: 25_400, max: 200_000 } },
	)

	expect(text).toBe('05-fit: Web status line · hal · Opus 4.6 · 25k/200k (13%)')
})

test('omits parts that are unknown or redundant', () => {
	expect(webStatus.text({ id: '05-fit', name: '05-fit', cwd: '/root/hal' }, { id: '05-fit', createdAt: '' })).toBe('05-fit · hal')
	expect(webStatus.text(undefined, undefined)).toBe('')
})

test('keeps the root directory visible instead of collapsing it to nothing', () => {
	expect(webStatus.text({ id: '05-fit', cwd: '/' }, undefined)).toBe('05-fit · /')
})
