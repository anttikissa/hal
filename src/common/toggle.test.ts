import { expect, test } from 'bun:test'
import { toggle, type Fold } from './toggle.ts'
import type { Item } from './transcript.ts'

test('/toggle targets: kind letters ignored, ranges skip assistant text and user prompts, prompts with pastes have three states', () => {
	for (let t of ['#t24', 't24', '#24', '24']) expect(toggle.parse(t)).toEqual({ from: 24, to: 24, range: false })
	expect(toggle.parse('24-10')).toEqual({ from: 10, to: 24, range: true })
	expect(toggle.parse('ten')).toBe(toggle.USAGE)
	let items = [
		{ type: 'prompt', key: '10', text: 'see [paste/abc123.txt]' },
		{ type: 'thinking', key: '11', text: 'hmm' },
		{ type: 'text', key: '12', text: 'answer' },
		{ type: 'prompt', key: '13', text: 'hi', from: 'other', summary: 'Hi' },
		{ type: 'tool', key: '14', id: 'a', name: 'bash', input: {} },
		{ type: 'tool-result', key: '15', id: 'a', output: 'x' },
	] as Item[]
	let states = new Map<string, Fold>()
	expect(toggle.flip(states, items, toggle.parse('10-15') as never)).toEqual(['11', '13', '14'])
	expect([...states]).toEqual([['11', 'closed'], ['13', 'open'], ['14', 'open']])
	expect(toggle.flip(states, items, toggle.parse('') as never)).toEqual(['14'])
	expect(toggle.flip(states, items, toggle.parse('15') as never)).toBe('block 15 does not open or close')
	expect(toggle.flip(states, items, toggle.parse('16') as never)).toBe('no block 16 to toggle')
	let steps = [1, 2, 3].map(() => (toggle.flip(states, items, toggle.parse('#u10') as never), states.get('10')))
	expect(steps).toEqual(['inline', 'closed', 'open'])
})
