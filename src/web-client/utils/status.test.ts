import { expect, test } from 'bun:test'
import { webStatus } from './status.ts'

test('keeps the header focused on the selected session', () => {
	const text = webStatus.text(
		{ id: '05-fit', name: 'Web status line', cwd: '/root/hal', model: 'anthropic/claude-opus-4-6' },
	)

	expect(text).toBe('05-fit: Web status line')
})

test('formats context for the composer status row', () => {
	expect(webStatus.contextText({ id: '05-fit', createdAt: '', context: { used: 25_400, max: 200_000 } })).toBe('25k/200k (13%)')
	expect(webStatus.contextText({ id: '05-fit', createdAt: '' })).toBe('')
})

test('omits parts that are unknown or redundant', () => {
	expect(webStatus.text({ id: '05-fit', name: '05-fit', cwd: '/root/hal' })).toBe('05-fit')
	expect(webStatus.text(undefined)).toBe('')
})

test('pairs the directory with the model, as the terminal status line does', () => {
	expect(webStatus.location({ id: '05-fit', cwd: '/root/hal', model: 'anthropic/claude-opus-4-6' })).toBe('/root/hal · Opus 4.6')
	expect(webStatus.location({ id: '05-fit', cwd: '/root/hal' })).toBe('/root/hal')
	expect(webStatus.location(undefined)).toBe('')
})
