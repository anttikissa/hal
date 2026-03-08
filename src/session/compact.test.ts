import { test, expect } from 'bun:test'
import { buildCompactionContext, type Message } from './messages.ts'

test('buildCompactionContext lists user prompts', () => {
	const msgs: Message[] = [
		{ role: 'user', content: 'hello world', ts: '' },
		{ role: 'assistant', text: 'hi', ts: '' },
		{ role: 'user', content: 'fix the bug', ts: '' },
		{ role: 'assistant', text: 'done', ts: '' },
	]
	const ctx = buildCompactionContext('test-sid', msgs)
	expect(ctx).toContain('1. hello world')
	expect(ctx).toContain('2. fix the bug')
	expect(ctx).toContain('compacted')
})

test('buildCompactionContext skips [bracketed] messages', () => {
	const msgs: Message[] = [
		{ role: 'user', content: '[interrupted — skipped]', ts: '' },
		{ role: 'user', content: 'real prompt', ts: '' },
	]
	const ctx = buildCompactionContext('test-sid', msgs)
	expect(ctx).not.toContain('interrupted')
	expect(ctx).toContain('1. real prompt')
})

test('buildCompactionContext truncates long lists to first/last 10', () => {
	const msgs: Message[] = []
	for (let i = 1; i <= 25; i++) {
		msgs.push({ role: 'user', content: `prompt ${i}`, ts: '' })
	}
	const ctx = buildCompactionContext('test-sid', msgs)
	expect(ctx).toContain('First 10:')
	expect(ctx).toContain('Last 10:')
	expect(ctx).toContain('1. prompt 1')
	expect(ctx).toContain('10. prompt 10')
	expect(ctx).toContain('16. prompt 16')
	expect(ctx).toContain('25. prompt 25')
	// Middle prompts should not appear
	expect(ctx).not.toContain('11. prompt 11')
})

test('buildCompactionContext handles empty session', () => {
	const ctx = buildCompactionContext('test-sid', [])
	expect(ctx).toContain('No user prompts')
})

test('buildCompactionContext takes only first line of multi-line prompts', () => {
	const msgs: Message[] = [
		{ role: 'user', content: 'first line\nsecond line\nthird line', ts: '' },
	]
	const ctx = buildCompactionContext('test-sid', msgs)
	expect(ctx).toContain('1. first line')
	expect(ctx).not.toContain('second line')
})
