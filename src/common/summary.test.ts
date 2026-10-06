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

test('a stray unclosed tag in prose hides nothing after it', () => {
	let prose = "A push reads 'done: <summary>'.\n\nMore text."
	let full = prose + '\n\n<summary>Done.</summary>'
	expect(summary.strip(full)).toBe(prose)
	expect(summary.extract(full)).toBe('Done.')
})

// Task nd6: a <question> line works like a summary and marks a turn that waits.
test('a question tag is hidden and extracted like a summary, and marks the reply as asking', () => {
	let full = 'Two options.\n\n<question>Use the new API or keep the old one?</question>'
	expect(summary.strip(full)).toBe('Two options.')
	expect(summary.extract(full)).toBe('Use the new API or keep the old one?')
	expect(summary.asks(full)).toBe(true)
	for (let n = 'Two options.'.length; n <= full.length; n++) expect(summary.strip(full.slice(0, n))).toBe('Two options.')
	expect(summary.asks('Done.\n<summary>Done.</summary>')).toBe(false)
	expect(summary.asks('Asking `<question>x</question>` in code.')).toBe(false)
})

test('notification-only answers stay visible without duplicating normal answers', () => {
	for (let tag of ['summary', 'question']) {
		let text = `<${tag}>Stopped.</${tag}>`
		expect(summary.answer(text)).toBe('Stopped.')
		expect(summary.answer(` \n${text}\n`)).toBe('Stopped.')
		expect(summary.answer(`Visible answer.\n${text}`)).toBe('Visible answer.')
		expect(summary.answer(`${text}\n<rename>New name</rename>`)).toBe('Stopped.')
		for (let n = 1; n < text.length; n++) expect(summary.answer(text.slice(0, n))).toBe('')
	}
	expect(summary.answer('`<summary>Example.</summary>`')).toBe('`<summary>Example.</summary>`')
	expect(summary.answer('<rename>New name</rename>')).toBe('')
})
