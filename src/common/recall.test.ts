import { beforeEach, expect, test } from 'bun:test'
import { recall } from './recall.ts'
import { transcript } from './transcript.ts'

beforeEach(() => recall.reset())

const list = ['one', 'two\nlines', 'three']
const up = (text: string, cursor = 0, width = Infinity) => recall.step('s', list, text, cursor, -1, width, 'mine')
const down = (text: string, cursor = text.length, width = Infinity) => recall.step('s', list, text, cursor, 1, width, 'mine')

test('the entries are the prompts in the transcript, oldest first, edits as edited', () => {
	let t = transcript.fold(undefined, { type: 'snapshot', sessionId: 's', snapshot: { meta: { id: 's', cwd: '/', model: 'a/b', createdAt: '' }, history: [], state: { type: 'idle' } } } as any)!
	t = transcript.fold(t, { type: 'turn-start', sessionId: 's', prompt: 'first', provider: 'p' } as any)!
	t = transcript.fold(t, { type: 'turn-start', sessionId: 's', prompt: 'secnd', provider: 'p' } as any)!
	t = transcript.fold(t, { type: 'prompt', sessionId: 's', texts: ['second'], replaces: true } as any)!
	expect(recall.entries(t)).toEqual(['first', 'second'])
})

test('Up walks back through the entries, cursor at the end; Down walks forward to the own text', () => {
	expect(up('mine')).toEqual({ text: 'three', cursor: 5 })
	expect(up('three')).toEqual({ text: 'two\nlines', cursor: 9 })
	expect(up('two\nlines', 3)).toEqual({ text: 'one', cursor: 3 })
	// The oldest: Up is the editor's own (to the text's start).
	expect(up('one', 3)).toBeUndefined()
	expect(down('one')).toEqual({ text: 'two\nlines', cursor: 3 })
	expect(down('two\nlines', 9)).toEqual({ text: 'three', cursor: 5 })
	expect(down('three')).toEqual({ text: 'mine', cursor: 4 })
	expect(recall.shown('s')).toBeUndefined()
	// Not browsing: Down is the editor's own.
	expect(down('mine')).toBeUndefined()
})

test('only the top row recalls with Up and the bottom row with Down', () => {
	expect(up('a\nb', 3)).toBeUndefined()
	expect(up('a\nb', 1)).toEqual({ text: 'three', cursor: 5 })
	expect(up('three')).toEqual({ text: 'two\nlines', cursor: 9 })
	expect(down('two\nlines', 2)).toBeUndefined()
	// Wrapped rows count at the given width.
	recall.reset()
	expect(up('aaaa bbbb', 9, 5)).toBeUndefined()
	expect(up('aaaa bbbb', 2, 5)).toEqual({ text: 'three', cursor: 5 })
})

test('going down puts the cursor at the end of the top row', () => {
	up('mine')
	up('three')
	up('two\nlines')
	expect(down('one')).toEqual({ text: 'two\nlines', cursor: 3 })
	recall.reset()
	let long = ['aaaa bbbb', 'x']
	recall.step('s', long, '', 0, -1, 5, '')
	recall.step('s', long, 'x', 0, -1, 5, '')
	expect(recall.step('s', long, 'aaaa bbbb', 9, 1, 5, '')).toEqual({ text: 'x', cursor: 1 })
	expect(recall.step('s', long, 'x', 1, 1, 5, 'cccc dddd')).toEqual({ text: 'cccc dddd', cursor: 4 })
})

test('with no history Up and Down are the editor own', () => {
	expect(recall.step('s', [], 'x', 0, -1, Infinity, '')).toBeUndefined()
	expect(recall.step('s', [], 'x', 1, 1, Infinity, '')).toBeUndefined()
})

test('the first Up skips the entry still in the editor', () => {
	expect(up('three', 5)).toEqual({ text: 'two\nlines', cursor: 9 })
	expect(recall.step('t', ['only'], 'only', 0, -1, Infinity, '')).toBeUndefined()
})

test('editing keeps the browsing position and saves even restored text as the draft', () => {
	up('mine')
	expect(recall.typed('s', 'three')).toBe(false)
	expect(recall.shown('s')).toBe('three')
	expect(recall.typed('s', 'three!')).toBe(true)
	expect(recall.shown('s')).toBe('three!')
	expect(recall.typed('s', 'three')).toBe(true)
	expect(up('three')).toEqual({ text: 'two\nlines', cursor: 9 })
})

test('browsing belongs to its session', () => {
	up('mine')
	expect(recall.shown('other')).toBeUndefined()
	expect(recall.step('other', list, '', 0, 1, Infinity, '')).toBeUndefined()
	expect(recall.shown('s')).toBe('three')
	expect(recall.stop('s')).toBe(true)
	expect(recall.stop('s')).toBe(false)
})

test('recall excludes agent and model-generated prompts, not human continuations', () => {
	let t = transcript.fold(undefined, { type: 'snapshot', sessionId: 's', snapshot: { meta: { id: 's', cwd: '/', model: 'a/b', createdAt: '' }, history: [], state: { type: 'idle' } } } as any)!
	t.items.push(
		{ type: 'prompt', key: '1', text: 'human' },
		{ type: 'prompt', key: '2', text: 'agent', from: 'other' },
		{ type: 'prompt', key: '3', text: 'generated', origin: 'model' },
		{ type: 'prompt', key: '4', text: 'human continuation', generatingCommand: 'clear' },
	)
	expect(recall.entries(t)).toEqual(['human', 'human continuation'])
})
