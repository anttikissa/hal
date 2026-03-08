import { test, expect } from 'bun:test'
import { loadSystemPrompt } from './system-prompt.ts'

test('loads SYSTEM.md with variable substitution', () => {
	const result = loadSystemPrompt({ model: 'claude-sonnet-4-20250514', sessionDir: 'test-session' })
	// Should contain content from SYSTEM.md
	expect(result.length).toBeGreaterThan(100)
	// Variables should be substituted (no raw ${...} remaining for known vars)
	expect(result).not.toContain('${model}')
	expect(result).not.toContain('${date}')
	expect(result).not.toContain('${hal_dir}')
	// Model should appear
	expect(result).toContain('claude-sonnet-4-20250514')
})

test('strips HTML comments', () => {
	const result = loadSystemPrompt()
	expect(result).not.toMatch(/<!--/)
})

test('collapses triple newlines', () => {
	const result = loadSystemPrompt()
	expect(result).not.toMatch(/\n{3,}/)
})

test('processes ::: if directives', () => {
	const result = loadSystemPrompt({ model: 'claude-sonnet-4-20250514' })
	// Should not contain the directive syntax itself
	expect(result).not.toMatch(/^:{3,}\s+if/m)
})
