import { expect, test } from 'bun:test'
import { amend } from './amend.ts'
import { drafts } from './drafts.ts'
import type { Snapshot } from './snapshot.ts'
import type { SessionState } from './states.ts'
import { transcript, type Transcript } from './transcript.ts'

const ts = '2026-09-26T00:00:01Z'
const meta = { id: 's1', cwd: '/w', model: 'fake/m', createdAt: ts }

function session(state: SessionState, prompts: string[][] = [['hi'], ['fix ti']]): Transcript {
	let history: Snapshot['history'] = prompts.flatMap((texts) => [
		{ type: 'user' as const, blocks: texts.map((text) => ({ type: 'text' as const, text })), ts },
		{ type: 'assistant' as const, block: { type: 'text' as const, text: 'ok' }, ts },
	])
	return transcript.fromSnapshot({ meta, history, state })
}
const running: SessionState = { type: 'running', phase: 'streaming' }

test('Up on an empty prompt while the model works pauses it and edits the last prompt', () => {
	for (let state of [running, { type: 'blocked', reason: 'question' }] as SessionState[]) {
		expect(amend.begin(session(state))).toMatchObject({
			editing: { sessionId: 's1', original: 'fix ti', paused: true },
			command: { type: 'pause', sessionId: 's1' },
		})
	}
	// The last text the user sent, not a steering message delivered before it.
	expect(amend.begin(session(running, [['steer', 'typed']]))?.editing.original).toBe('typed')
	// Not with text typed, not when nothing works, not without a prompt.
	for (let state of [{ type: 'idle' }, { type: 'paused' }, { type: 'error', message: 'x' }] as SessionState[])
		expect(amend.begin(session(state))).toBeUndefined()
	expect(amend.begin(session(running, []))).toBeUndefined()
	expect(amend.begin(undefined)).toBeUndefined()
})

test('Enter sends the edit for the host to place; an emptied edit just continues', () => {
	let editing = { sessionId: 's1', original: 'fix ti', target: '5' }
	let paused = session({ type: 'paused' })
	expect(amend.enter(editing, paused, 'fix it')).toEqual({ type: 'submit', sessionId: 's1', text: '/edit 5\nfix it' })
	expect(amend.enter(editing, paused, '  ')).toEqual({ type: 'continue', sessionId: 's1' })
	expect(amend.enter(editing, paused, 'fix ti')).toEqual({ type: 'continue', sessionId: 's1' })
	expect(amend.hint(editing, 'fix ti')).not.toContain('enter:')
	expect(amend.hint(editing, 'fix it')).toContain('enter: edit')
	expect(amend.hint({ ...editing, changed: true }, 'fix it')).toContain('enter: send as new')
	// Alt-Enter queues it as a new message instead.
	expect(amend.enter(editing, paused, 'later', true)).toEqual({
		type: 'submit',
		sessionId: 's1',
		text: 'later',
		delivery: 'queue',
	})
})

test('leaving the edit continues the paused turn, or the one whose pause is on its way', () => {
	let editing = { sessionId: 's1', original: 'fix ti' }
	expect(amend.resume(editing, session({ type: 'paused' }))).toEqual({ type: 'continue', sessionId: 's1' })
	expect(amend.resume(editing, session(running))).toEqual({ type: 'continue', sessionId: 's1' })
	// It ended by itself meanwhile, or another session is on screen.
	expect(amend.resume(editing, session({ type: 'idle' }))).toBeUndefined()
	expect(amend.resume(editing, session({ type: 'error', message: 'x' }))).toBeUndefined()
	expect(amend.resume({ ...editing, sessionId: 's2' }, session({ type: 'paused' }))).toBeUndefined()
})

test('Up edits a steering message still waiting in the inbox in place, without pausing', () => {
	let t = {
		...session({ type: 'paused' }),
		inbox: [
			{ id: 'm1', text: 'steer' },
			{ id: 'm2', text: 'latre' },
		],
	}
	let begun = amend.begin(t)
	expect(begun).toEqual({ editing: { sessionId: 's1', original: 'latre', inbox: 'm2' } })
	expect(amend.enter(begun!.editing, t, 'later')).toEqual({
		type: 'submit',
		sessionId: 's1',
		text: 'later',
		amend: true,
		edits: 'm2',
	})
	// Nothing was paused, so leaving the edit continues nothing.
	expect(amend.resume(begun!.editing, t)).toBeUndefined()
})

test('Up right after Enter edits the prompt the host has not acknowledged yet', () => {
	// Sent to an idle session: it starts a turn, so Up pauses it.
	drafts.local('s1').sending.push({ id: 'c1', text: 'helo' })
	let idle = session({ type: 'idle' })
	let begun = amend.begin(idle)
	expect(begun).toEqual({
		editing: { sessionId: 's1', original: 'helo', inbox: 'c1', paused: true },
		command: { type: 'pause', sessionId: 's1' },
	})
	expect(amend.enter(begun!.editing, idle, 'hello')).toEqual({
		type: 'submit',
		sessionId: 's1',
		text: 'hello',
		amend: true,
		edits: 'c1',
	})
	expect(amend.resume(begun!.editing, session({ type: 'paused' }))).toEqual({ type: 'continue', sessionId: 's1' })
	// Sent to a working session: it steers, so nothing pauses.
	expect(amend.begin(session(running))).toEqual({ editing: { sessionId: 's1', original: 'helo', inbox: 'c1' } })
	drafts.reset()
})

test('Up never recalls what another session sent', () => {
	let t = session(running)
	let peer = {
		...t,
		inbox: [
			{ id: 'm1', text: 'mine' },
			{ id: 'm2', text: 'theirs', from: 's9' },
		],
	}
	expect(amend.begin(peer)?.editing).toEqual({ sessionId: 's1', original: 'mine', inbox: 'm1' })
	let delivered = {
		...t,
		items: [...t.items, { type: 'prompt' as const, text: 'theirs', from: 's9', key: 'x' }],
		inbox: [{ id: 'm2', text: 'theirs', from: 's9' }],
	}
	expect(amend.begin(delivered)?.editing).toMatchObject({ sessionId: 's1', original: 'fix ti' })
})

test('unchanged edits continue without sending, and older targets respect side effects', () => {
	let t = transcript.fromSnapshot({
		meta,
		state: { type: 'paused' },
		history: [
			{ type: 'user', blocks: [{ type: 'text', text: 'one' }], n: 1, ts },
			{ type: 'assistant', block: { type: 'text', text: 'answer' }, n: 2, ts },
			{ type: 'user', blocks: [{ type: 'text', text: 'two' }], n: 3, ts },
		],
	})
	let last = { ...amend.at(t, '3')!.editing, paused: true }
	expect(amend.enter(last, t, 'two')).toEqual({ type: 'continue', sessionId: 's1' })
	expect(amend.hint(last, 'two')).not.toContain('enter:')
	expect(amend.hint(last, 'twoa')).toContain('enter: edit')
	let earlier = amend.step(last, t, -1)!
	expect(earlier.rewind).toBe(1)
	expect(amend.enter(earlier, t, 'uno')).toEqual({ type: 'submit', sessionId: 's1', text: '/edit 1\nuno' })
	expect(amend.step(earlier, t, 1)?.original).toBe('two')
	t.items.push({ type: 'tool', key: '4', id: 't1', name: 'command', input: { command: '/rename Title' } })
	expect(amend.at(t, '1')!.editing.changed).toBe(false)
	t.items.push({ type: 'tool', key: '5', id: 't2', name: 'edit', input: { path: 'x' } })
	let changed = amend.at(t, '1')!.editing
	expect(amend.enter(changed, t, 'uno')).toEqual({ type: 'submit', sessionId: 's1', text: 'uno' })
	expect(amend.hint(changed, 'uno')).toContain('enter: send as new')
})
