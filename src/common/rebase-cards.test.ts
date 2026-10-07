import { expect, test } from 'bun:test'
import { rebaseCards } from './rebase-cards.ts'
import { toggle } from './toggle.ts'
import { target } from '../web/target.ts'
import { view } from '../web/view.ts'
import type { Item } from './transcript.ts'

const call: Item = { type: 'tool', id: 'c', key: '2', name: 'command', input: { command: '/rebase run drop #1' } }
const result: Item = { type: 'tool-result', id: 'c', key: '3', output: 'Rebase queued for the next round.' }
const divider: Item = { type: 'divider', key: '4', text: 'History rewritten · /rebase undo · 1 dropped, 0 edited · cache rebuilds from #1' }

test('grouped reports preserve records, statuses, errors, undo and constituent targets', () => {
	let error: Item = { type: 'output', key: '6', text: 'Invalid rebase\nfull raw input', error: true }
	let items: Item[] = [call, result, divider, { type: 'command', key: '5', text: '/rebase invalid' }, error]
	let before = JSON.stringify(items), grouped = rebaseCards.group(items)
	expect(grouped).toHaveLength(1)
	expect(rebaseCards.members(grouped[0]!)).toEqual(items)
	expect(rebaseCards.group(items)[0]).toBe(grouped[0])
	expect(grouped[0]).toMatchObject({ key: '2', error: true })
	expect(rebaseCards.members(grouped[0]!).map(rebaseCards.detail).join('\n')).toContain('Rebase queued for the next round.')
	expect(rebaseCards.undo(grouped[0]!)).toBe(true)
	expect(toggle.resolve(items, toggle.parse('6') as never)).toEqual(grouped)
	expect(target.row(view.rows(items), '6')?.item).toBe(grouped[0])
	expect(JSON.stringify(items)).toBe(before)
})

test('conversation and unrelated tools break runs; an appended result updates only its group', () => {
	let prompt: Item = { type: 'prompt', key: '7', text: 'Keep this separate' }
	let other: Item = { type: 'tool', id: 'other', key: '8', name: 'read', input: { path: 'a' } }
	let first = rebaseCards.group([call])[0]
	let next = rebaseCards.group([call, result, prompt, divider, other])
	expect(next).toHaveLength(4)
	expect(next[0]).not.toBe(first)
	expect(next[1]).toBe(prompt)
	expect(next[3]).toBe(other)
	expect(rebaseCards.members(next[0]!)).toEqual([call, result])
})


test('self-removed calls still group their applied report and retain queued versus applied details', () => {
	let accepted: Item = { type: 'output', key: '10', text: '/rebase accepted; applying after active work settles.' }
	let applied: Item = { type: 'output', key: '12', text: 'Rebase applied (dropped 0 entries, edited 1)\nEdited #2:\n```diff\n-old\n+new\n```' }
	let group = rebaseCards.group([accepted, divider, applied])[0]!
	expect(rebaseCards.members(group)).toEqual([accepted, divider, applied])
	expect(group).toMatchObject({ text: 'Rebase applied (dropped 0 entries, edited 1)' })
	let states = new Map()
	expect(toggle.apply('expand', states, [call, result, divider], 't3-4')).toEqual(['2'])
	expect(states.get('2')).toBe('open')
})


test('show and still-running command cards keep their native intent, details and streaming state', () => {
	let show: Item = { ...call, input: { command: '/rebase show' } }
	let running: Item = { ...call, partial: 'Working now' }
	expect(rebaseCards.group([show, result])).toEqual([show, result])
	expect(view.rows([show, result])[0]).toMatchObject({ item: show, result })
	expect(rebaseCards.group([running])[0]).toBe(running)
})
