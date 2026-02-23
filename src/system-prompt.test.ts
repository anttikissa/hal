import { describe, test, expect } from 'bun:test'

// processDirectives is not exported, so we duplicate it here for unit testing.
function processDirectives(text: string, vars: Record<string, string>): string {
	const lines = text.split('\n')
	const result: string[] = []
	let inFence = false
	let accept = true

	for (const line of lines) {
		const openMatch = line.match(/^:{3,}\s+if\s+(\w+)="([^"]+)"\s*$/)
		if (openMatch && !inFence) {
			inFence = true
			const value = vars[openMatch[1]] ?? ''
			const regex = new RegExp('^' + openMatch[2].replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
			accept = regex.test(value)
			continue
		}

		if (/^:{3,}\s*$/.test(line) && inFence) {
			inFence = false
			accept = true
			continue
		}

		if (accept) result.push(line)
	}

	return result.join('\n')
}

describe('processDirectives', () => {
	test('includes content when model matches', () => {
		const text = [
			'before',
			'::: if model="claude-*"',
			'claude stuff',
			':::',
			'after',
		].join('\n')
		const result = processDirectives(text, { model: 'claude-opus-4-6' })
		expect(result).toBe('before\nclaude stuff\nafter')
	})

	test('excludes content when model does not match', () => {
		const text = [
			'before',
			'::: if model="claude-*"',
			'claude stuff',
			':::',
			'after',
		].join('\n')
		const result = processDirectives(text, { model: 'gpt-5.3-codex' })
		expect(result).toBe('before\nafter')
	})

	test('handles multiple conditional blocks', () => {
		const text = [
			'::: if model="claude-*"',
			'claude',
			':::',
			'shared',
			'::: if model="gpt-*"',
			'gpt',
			':::',
		].join('\n')
		const result = processDirectives(text, { model: 'gpt-5.3-codex' })
		expect(result).toBe('shared\ngpt')
	})

	test('supports ? wildcard for single char', () => {
		const text = [
			'::: if model="o?-mini"',
			'matched',
			':::',
		].join('\n')
		expect(processDirectives(text, { model: 'o3-mini' })).toBe('matched')
		expect(processDirectives(text, { model: 'o42-mini' })).toBe('')
	})

	test('supports arbitrary variable names', () => {
		const text = [
			'::: if provider="openai"',
			'openai stuff',
			':::',
		].join('\n')
		expect(processDirectives(text, { provider: 'openai' })).toBe('openai stuff')
		expect(processDirectives(text, { provider: 'anthropic' })).toBe('')
	})

	test('missing variable does not match', () => {
		const text = [
			'::: if foo="bar"',
			'content',
			':::',
		].join('\n')
		expect(processDirectives(text, {})).toBe('')
	})

	test('no directives passes through unchanged', () => {
		const text = 'hello\nworld'
		expect(processDirectives(text, { model: 'anything' })).toBe('hello\nworld')
	})

	test('ignores nested opener inside an active block', () => {
		// A second opener while already inside a block is treated as plain text
		const text = [
			'::: if model="gpt-*"',
			'line1',
			'::: if model="gpt-5*"',
			'line2',
			':::',
			'after',
		].join('\n')
		// The inner opener is ignored; first ::: closes the block
		const result = processDirectives(text, { model: 'gpt-5' })
		expect(result).toBe('line1\n::: if model="gpt-5*"\nline2\nafter')
	})
})
