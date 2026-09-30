import { expect, test } from 'bun:test'
import { names } from './names.ts'
import { summary } from './summary.ts'

test('split suffixes stay hidden in both summary orders; examples and prose are not controls', () => {
	for (let full of ['Done.\n<rename>Repair provider replay</rename>\n<summary>Fixed</summary>', 'Done.\n<summary>Fixed</summary>\n<rename>Repair provider replay</rename>']) {
		for (let n = 5; n <= full.length; n++) expect(names.strip(summary.strip(full.slice(0, n)))).toBe('Done.')
		expect(names.suffix(full)?.title).toBe('Repair provider replay')
	}
	for (let text of ['Example: <rename>Not a control</rename>', '```xml\n<rename>Not a control</rename>', '> <rename>Not a control</rename>', 'Done.\n<rename>A</rename>\n<rename>B</rename>']) expect(names.suffix(text)).toBeUndefined()
})

test('titles validate the whole input before normalising, counting Unicode characters', () => {
	expect(names.validate('  Fix   😀 replay  ')).toBe('Fix 😀 replay')
	expect(names.validate('😀'.repeat(60))).toHaveLength(120)
	for (let text of ['', 'x'.repeat(61), 'safe\x1b[2J', 'safe\nunsafe', 'safe<em>unsafe</em>', 'safe\u202eunsafe']) expect(() => names.validate(text)).toThrow()
})

test('legacy tags hide without altering fenced or inline examples, including partial streaming', () => {
	for (let text of ['Example: <rename>Title</rename>', '```xml\n<rename>Title', '```xml\n<rename>Title</rename>\n```', '> <rename>Title</rename>']) expect(names.strip(text)).toBe(text)
})
