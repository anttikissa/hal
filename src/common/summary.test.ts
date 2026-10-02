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

test('fenced and inline examples survive stripping and do not supply notifications', () => {
	let examples = [
		'```text\n<summary>Example.</summary>\n```',
		'````text\n```\n<summary>Example.</summary>\n````',
		'~~~text\n<summary>Example.</summary>\n~~~',
		'Use `literal <summary>Example.</summary>` here.',
		'Use ``a ` and <summary>Example.</summary>`` here.',
	]
	for (let example of examples) {
		expect(summary.strip(example)).toBe(example)
		expect(summary.extract(example)).toBeUndefined()
		let full = example + '\n\n<summary>Real notice.</summary>'
		expect(summary.extract(full)).toBe('Real notice.')
		for (let n = example.length; n <= full.length; n++) expect(summary.strip(full.slice(0, n))).toBe(example)
	}
})

test('streaming literal tags stay visible and escaped backticks do not open code', () => {
	for (let prefix of ['```text\n', '~~~\n', 'Example `literal ']) {
		let literal = '<summary>Example.</summary>'
		for (let n = 1; n <= literal.length; n++) {
			let text = prefix + literal.slice(0, n)
			expect(summary.strip(text)).toBe(text)
			expect(summary.extract(text)).toBeUndefined()
		}
	}
	expect(summary.strip('Escaped \\` marker.\n<summary>Done.</summary>')).toBe('Escaped \\` marker.')
})
