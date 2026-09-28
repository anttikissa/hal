// The chrome below the transcript (task p0): prompt box between rules,
// then one help row whatever it says. Seen through frame.build.
import { expect, test } from 'bun:test'
import { forms } from '../common/forms.ts'
import type { SessionState } from '../common/states.ts'
import { strings } from '../common/strings.ts'
import type { Shown as Item, Transcript } from '../common/transcript.ts'
import { frame, type View } from './frame.ts'

function strip(s: string): string {
	let out = ''
	strings.walk(s, 0, (i, _w, len) => {
		out += s.slice(i, i + len)
	})
	return out.trim()
}

function view(state: SessionState, text = '', items: Item[] = []): View {
	let transcript: Transcript = { meta: { id: 's', cwd: '/', model: 'm', createdAt: '' }, state, inbox: [], items: items.map((item, i) => ({ ...item, key: `~${i}` })) }
	return { transcript, prompt: { text, cursor: text.length } }
}

const help = (v: View, cols = 100) => strip(frame.build(v, cols).lines.at(-1)!)
const chrome = (v: View) => frame.build(v, 60).lines.length
const running: SessionState = { type: 'running', phase: 'requesting' }

test('each state shows its key hints, with /keys at the right', () => {
	let idle: SessionState = { type: 'idle' }
	expect(help(view(idle))).toBe('/keys: shortcuts')
	expect(help(view(idle, 'hi'))).toMatch(/^enter: send, shift-enter: newline, alt-enter: queue +\/keys: shortcuts$/)
	// Blank text is no text.
	expect(help(view(idle, '  \n'))).toBe('/keys: shortcuts')
	expect(help(view(running))).toMatch(/^esc: pause +\/keys/)
	expect(help(view(running, 'more'))).toMatch(/^enter: steer, alt-enter: queue, shift-enter: newline, esc: pause +\/keys/)
	expect(help(view({ type: 'retrying', at: '', reason: 'overloaded' }))).toMatch(/^esc: pause /)
	expect(help(view({ type: 'paused' }))).toMatch(/^enter: continue +\/keys/)
	expect(help(view({ type: 'error', message: 'boom' }))).toMatch(/^enter: retry +\/keys/)
	// Text wins over continuing: Enter sends it.
	expect(help(view({ type: 'paused' }, 'x'))).toMatch(/^enter: send/)
})

test('keys and descriptions differ in colour', () => {
	let row = frame.build(view({ type: 'idle' }, 'hi'), 100).lines.at(-1)!
	let colourOf = (word: string) => row.slice(0, row.indexOf(word)).match(/\x1b\[[0-9;]*m(?!.*\x1b\[)/s)?.[0]
	expect(colourOf('enter')).not.toBe(colourOf('send'))
})

test('a question, then editing, then completion choices outrank the key hints', () => {
	let form = { text: 'Run?', fields: [{ type: 'choice' as const, name: 'ok', options: ['yes', 'no'] }] }
	let asked = { ...view({ type: 'blocked', reason: 'question' }, 'x', [{ type: 'question', id: 'q', form }]), form: forms.start('q', form) }
	let all: View = { ...asked, editing: 'editing the last prompt', choices: ['/cd a', '/cd b'] }
	expect(help(all)).toMatch(/choose.*enter: submit, esc: pause/)
	expect(help({ ...all, form: undefined })).toBe('editing the last prompt')
	expect(help({ ...all, form: undefined, editing: undefined })).toBe('/cd a  /cd b')
	let text = { ...asked, form: forms.start('q', { text: 'Name?', fields: [{ type: 'text', name: 'n' }] }) }
	expect(help(text)).toBe('enter: submit, esc: pause')
})

test('the chrome keeps its height: choices, a question and working change only the help row', () => {
	let idle = view({ type: 'idle' }, '/c')
	let base = chrome(idle)
	let many = Array.from({ length: 40 }, (_, i) => `/choice-${i}`)
	expect(chrome({ ...idle, choices: many })).toBe(base)
	expect(strings.visLen(frame.build({ ...idle, choices: many }, 60).lines.at(-1)!)).toBeLessThanOrEqual(60)
	expect(chrome({ ...view(running, '/c'), activity: 'processing' })).toBe(base)
	expect(chrome({ ...idle, editing: 'editing the last prompt: Enter sends it, Down or Escape continues, and more words than fit' })).toBe(base)
	// A question adds its own rows above the chrome, never below it.
	let form = { text: 'Name?', fields: [{ type: 'text' as const, name: 'n' }] }
	let q: Item = { type: 'question', id: 'q', form }
	let asked = view({ type: 'blocked', reason: 'question' }, '/c', [q])
	let f = frame.build({ ...asked, form: forms.start('q', form) }, 60)
	let plain = frame.build(asked, 60)
	expect(f.lines.slice(-4).map(strip).slice(0, 3)).toEqual(plain.lines.slice(-4).map(strip).slice(0, 3))
})

test('the top rule carries the activity centred and the fold count at its left', () => {
	let rows = (v: View) => frame.build(v, 40).lines.map(strip)
	let top = rows({ ...view(running), activity: 'running bash' }).find((l) => l.includes('running bash'))!
	expect(top).toMatch(/^─+ running bash ─+$/)
	let [before, after] = top.split(' running bash ')
	expect(Math.abs(before!.length - after!.length)).toBeLessThanOrEqual(1)
	let long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
	let folded = rows({ ...view(running, long), activity: 'thinking' })
	expect(folded.find((l) => l.includes('thinking'))).toMatch(/^↑\d+ ─+ thinking ─+$/)
})
