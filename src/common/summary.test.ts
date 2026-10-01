import { expect, test } from 'bun:test'
import { summary } from './summary.ts'

test('the summary is hidden from the answer, also while it streams in', () => {
	let full = 'All done.\n\n<summary>Tests pass.</summary>'
	expect(summary.strip(full)).toBe('All done.')
	expect(summary.extract(full)).toBe('Tests pass.')
	// Every prefix of the streamed answer shows no part of the tag.
	for (let n = 'All done.'.length; n <= full.length; n++) expect(summary.strip(full.slice(0, n))).toBe('All done.')
	expect(summary.strip('a < b')).toBe('a < b')
	expect(summary.extract('no tag')).toBeUndefined()
})

test('a tag quoted in code is text, not the summary', () => {
	let full = 'Reports use their `<summary>` line.\n\n<summary>Done.</summary>'
	expect(summary.strip(full)).toBe('Reports use their `<summary>` line.')
	expect(summary.extract(full)).toBe('Done.')
	for (let n = 'Reports use their `<summary>` line.'.length; n <= full.length; n++) expect(summary.strip(full.slice(0, n))).toBe('Reports use their `<summary>` line.')
})
