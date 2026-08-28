import { expect, test } from 'bun:test'
import { webStatus } from './status.ts'

test('crams session and context into the header line', () => {
	const text = webStatus.text(
		{ id: '05-fit', name: 'Web status line', cwd: '/root/hal', model: 'anthropic/claude-opus-4-6' },
		{ id: '05-fit', createdAt: '', context: { used: 25_400, max: 200_000 } },
	)

	expect(text).toBe('05-fit: Web status line · 25k/200k (13%)')
})

test('omits parts that are unknown or redundant', () => {
	expect(webStatus.text({ id: '05-fit', name: '05-fit', cwd: '/root/hal' }, { id: '05-fit', createdAt: '' })).toBe('05-fit')
	expect(webStatus.text(undefined, undefined)).toBe('')
})

test('pairs the directory with the model, as the terminal status line does', () => {
	expect(webStatus.location({ id: '05-fit', cwd: '/root/hal', model: 'anthropic/claude-opus-4-6' })).toBe('/root/hal · Opus 4.6')
	expect(webStatus.location({ id: '05-fit', cwd: '/root/hal' })).toBe('/root/hal')
	expect(webStatus.location(undefined)).toBe('')
})
