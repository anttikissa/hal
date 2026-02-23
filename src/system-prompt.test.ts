import { describe, test, expect } from 'bun:test'

// processDirectives is not exported, so we duplicate it here for unit testing.
function processDirectives(text: string, vars: Record<string, string>): string {
	const lines = text.split('\n')
	const result: string[] = []
	const stack: { colons: number; included: boolean }[] = []

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		const openMatch = line.match(/^(:{3,})\s+if\s+(\w+)="([^"]+)"\s*$/)
		if (openMatch) {
			const colons = openMatch[1].length
			const key = openMatch[2]
			const pattern = openMatch[3]
			const value = vars[key] ?? ''
			const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
			const matches = regex.test(value)
			const parentIncluded = stack.length === 0 || stack[stack.length - 1].included
			stack.push({ colons, included: matches && parentIncluded })
			continue
		}

		const closeMatch = line.match(/^(:{3,})\s*$/)
		if (closeMatch && stack.length > 0) {
			const colons = closeMatch[1].length
			const top = stack[stack.length - 1]
			if (colons <= top.colons) {
				stack.pop()
				continue
			}
		}

		if (stack.length === 0 || stack[stack.length - 1].included) {
			result.push(line)
		}
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

	test('nested blocks with more colons on outer', () => {
		const text = [
			':::: if model="gpt-*"',
			'outer',
			'::: if model="gpt-5*"',
			'inner',
			':::',
			'still outer',
			'::::',
			'after',
		].join('\n')

		// gpt-5.3 matches both
		const r1 = processDirectives(text, { model: 'gpt-5.3-codex' })
		expect(r1).toBe('outer\ninner\nstill outer\nafter')

		// gpt-4o matches outer but not inner
		const r2 = processDirectives(text, { model: 'gpt-4o' })
		expect(r2).toBe('outer\nstill outer\nafter')

		// claude matches neither
		const r3 = processDirectives(text, { model: 'claude-opus-4-6' })
		expect(r3).toBe('after')
	})

	test('inner block excluded when outer block excluded', () => {
		const text = [
			':::: if model="claude-*"',
			'claude only',
			'::: if model="claude-opus*"',
			'opus only',
			':::',
			'::::',
		].join('\n')
		// gpt should see nothing
		const result = processDirectives(text, { model: 'gpt-5' })
		expect(result).toBe('')
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

	test('colon fence inside included block is not mistaken for close', () => {
		// A `::::` inside a `:::` block should close it (fewer or equal colons)
		// But `::::` inside a `::::` block closes normally
		const text = [
			':::: if model="gpt-*"',
			'line1',
			'::::',
			'after',
		].join('\n')
		const result = processDirectives(text, { model: 'gpt-5' })
		expect(result).toBe('line1\nafter')
	})
})
