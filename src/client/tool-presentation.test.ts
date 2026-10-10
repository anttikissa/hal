import { expect, test } from 'bun:test'
import { itemView } from './item-view.ts'
import { toggle } from '../common/toggle.ts'
import type { Item } from '../common/transcript.ts'

const call: Item & { type: 'tool' } = { type: 'tool', key: '1', id: 'x', name: 'example-edit', input: { edits: [{ path: 'a.ts', old: 'before', new: 'after' }] }, presentation: { title: 'Edit a.ts', blocks: [] } }
const result: Item & { type: 'tool-result' } = { type: 'tool-result', key: '2', id: 'x', output: '-1 before\n+1 after\n', presentation: { title: 'Edited a.ts (+1 −1)', blocks: [{ kind: 'diff', path: 'a.ts', text: { from: 0, to: 18 } }] } }
const text = (item: Item, fold: 'open' | 'closed' | 'inline') => itemView.itemLines(item, 40, false, undefined, undefined, item.type === 'tool-result' ? call.name : undefined, [], { fold, result }).map(Bun.stripANSI).join('\n')

test('tool cards use shared title and diffs, retain exact raw details and expose full failures', () => {
	expect(text(call, 'closed')).toContain('Edited a.ts')
	expect(text(call, 'closed')).not.toContain('old:')
	expect(text(result, 'closed')).toBe('')
	expect(text(result, 'open')).toContain('a.ts\n-1 before\n+1 after')
	expect(toggle.next(call, 'open')).toBe('inline')
	expect(text(call, 'inline')).toMatch(/old:\s+before/)
	expect(text(result, 'inline')).toContain(result.output.trimEnd())
	let failure = { ...result, isError: true, output: 'Failure details\n'.repeat(300), presentation: { title: 'Failed', blocks: [] } }
	expect(text(failure, 'open').split('Failure details')).toHaveLength(301)
})
