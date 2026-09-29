import { expect, test } from 'bun:test'
import { fuzzy } from './fuzzy.ts'

const shown = (text: string, query: string) => {
	let out = ''
	let at = 0
	for (let [from, to] of fuzzy.marks(text, query)) {
		out += `${text.slice(at, from)}[${text.slice(from, to)}]`
		at = to
	}
	return out + text.slice(at)
}

test('marks every word of the query where a word of the text starts, in any case', () => {
	expect(shown('5.6-sol  GPT-5.6 Sol · openai/gpt-5.6-sol', 'gpt sol')).toBe('5.6-[sol]  [GPT]-5.6 [Sol] · openai/[gpt]-5.6-[sol]')
	// "5" is the start of 5.6 and 5 but not of 15.
	expect(shown('claude-opus-4-15 claude-opus-5', '5')).toBe('claude-opus-4-15 claude-opus-[5]')
	expect(shown('opus5 opus', 'opus5')).toBe('[opus5] [opus]')
})

test('a word found only inside words marks there; nothing found marks nothing', () => {
	expect(shown('claude-sonnet', 'onn')).toBe('claude-s[onn]et')
	expect(shown('claude-sonnet', 'gemini')).toBe('claude-sonnet')
	expect(fuzzy.marks('anything', '')).toEqual([])
})
