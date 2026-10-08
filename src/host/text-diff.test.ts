import { expect, test } from 'bun:test'
import { textDiff } from './text-diff.ts'
import { diff } from '../common/diff.ts'

// An EDIT card's numbers and changed lines (task ese).
test('a numbered diff numbers removals in the old file and the rest in the new', () => {
	let a = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
	let b = a.replace('line 3\n', 'LINE 3\nnew\n').replace('line 20\n', '').replace('line 40\n', '')
	let d = textDiff.text(a, b, Infinity, true)
	expect(d.split('\n').slice(0, 5)).toEqual(['  2 line 2', '- 3 line 3', '+ 3 LINE 3', '+ 4 new', '  5 line 4'])
	expect(diff.stats(d)).toEqual({ added: 2, removed: 3, lines: 'lines 3–4, 21, 39' })
})
