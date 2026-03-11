import { test, expect } from 'bun:test'
import { loadSystemPrompt } from './system-prompt.ts'

test('loads SYSTEM.md with variable substitution', () => {
	const result = loadSystemPrompt({ model: 'claude-sonnet-4-20250514', sessionDir: 'test-session' })
	expect(result.text.length).toBeGreaterThan(100)
	expect(result.bytes).toBeGreaterThan(100)
	expect(result.loaded).toContain('SYSTEM.md')
	expect(result.text).not.toContain('${model}')
	expect(result.text).not.toContain('${date}')
	expect(result.text).not.toContain('${hal_dir}')
	expect(result.text).toContain('claude-sonnet-4-20250514')
})

test('strips HTML comments', () => {
	const { text } = loadSystemPrompt()
	expect(text).not.toMatch(/<!--/)
})

test('collapses triple newlines', () => {
	const { text } = loadSystemPrompt()
	expect(text).not.toMatch(/\n{3,}/)
})

test('processes ::: if directives', () => {
	const { text } = loadSystemPrompt({ model: 'claude-sonnet-4-20250514' })
	expect(text).not.toMatch(/^:{3,}\s+if/m)
})


test('teaches blob placeholders and read_blob', () => {
	const { text } = loadSystemPrompt()
	expect(text).toContain('blob <id>')
	expect(text).toContain('read_blob')
})
