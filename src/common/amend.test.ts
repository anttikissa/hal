import { expect, test } from 'bun:test'
import { amend } from './amend.ts'
import type { Snapshot } from './protocol.ts'
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
	for (let state of [running, { type: 'retrying', at: ts, reason: 'x' }, { type: 'blocked', reason: 'log in' }] as SessionState[]) {
		expect(amend.begin(session(state), '')).toEqual({ editing: { sessionId: 's1', original: 'fix ti' }, command: { type: 'pause', sessionId: 's1' } })
	}
	// The last text the user sent, not a steering message delivered before it.
	expect(amend.begin(session(running, [['steer', 'typed']]), '')?.editing.original).toBe('typed')
	// Not with text typed, not when nothing works, not without a prompt.
	expect(amend.begin(session(running), 'draft')).toBeUndefined()
	for (let state of [{ type: 'idle' }, { type: 'paused' }, { type: 'error', message: 'x' }] as SessionState[]) expect(amend.begin(session(state), '')).toBeUndefined()
	expect(amend.begin(session(running, []), '')).toBeUndefined()
	expect(amend.begin(undefined, '')).toBeUndefined()
})

test('Enter sends the edit for the host to place; an emptied edit just continues', () => {
	let editing = { sessionId: 's1', original: 'fix ti' }
	let paused = session({ type: 'paused' })
	expect(amend.enter(editing, paused, 'fix it')).toEqual({ type: 'submit', sessionId: 's1', text: 'fix it', amend: true })
	expect(amend.enter(editing, paused, '  ')).toEqual({ type: 'continue', sessionId: 's1' })
	// Alt-Enter queues it as a new message instead.
	expect(amend.enter(editing, paused, 'later', true)).toEqual({ type: 'submit', sessionId: 's1', text: 'later', queue: true })
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
