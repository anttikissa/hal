import { afterEach, beforeEach, expect, test } from 'bun:test'
import { drafts } from '../common/drafts.ts'
import { keyHelp, type Binding } from '../common/key-help.ts'
import type { Event, Snapshot, Tab } from '../common/protocol.ts'
import type { SessionState } from '../common/states.ts'
import { app } from './app.ts'
import { clipboard } from './clipboard.ts'
import { emergency } from './emergency.ts'
import type { KeyEvent } from './keys.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'

// The terminal app with the host, renderer, terminal and clipboard all
// recorded, never real: the keys /keys lists and the clipboard keys.

let effects: unknown[] = []
let clip: { text: string } | { notice: string } = { text: 'clip' }
const saved = { send: app.send, show: render.show, quit: terminal.quit, redraw: terminal.redraw, draftSend: drafts.send, clipboard: { ...clipboard } }

beforeEach(() => {
	effects = []
	clip = { text: 'clip' }
	app.reset()
	app.send = (c: any) => effects.push(c.type)
	drafts.send = (c: any) => effects.push(c.type)
	render.show = () => {}
	terminal.quit = () => effects.push('quit')
	terminal.redraw = () => effects.push('redraw')
	clipboard.write = async (text) => (effects.push(`copy ${text}`), undefined)
	clipboard.read = async () => (effects.push('read'), clip)
})

afterEach(() => {
	app.send = saved.send
	drafts.send = saved.draftSend
	render.show = saved.show
	terminal.quit = saved.quit
	terminal.redraw = saved.redraw
	Object.assign(clipboard, saved.clipboard)
	app.reset()
})

const tab = (id: string): Tab => ({ id, name: id, cwd: `/${id}`, model: 'm', state: { type: 'idle' } })
const ids = [...'abcdefghijk']

// Eleven tabs shown on the last, `state`, prompt text with the cursor at
// `cursor` and a selection from `anchor`.
function open(state: SessionState, text: string, cursor: number, anchor?: number) {
	app.onEvent({ type: 'tabs', tabs: ids.map(tab) })
	app.onEvent({ type: 'ack', id: 'x', tab: 'k' })
	let snap: Snapshot = { meta: { id: 'k', cwd: '/', model: 'anthropic/x', createdAt: '' }, history: [], state }
	app.onEvent({ type: 'snapshot', sessionId: 'k', snapshot: snap })
	app.state.prompt = { text, cursor, kill: 'K', rows: 5, undo: [{ text: 'u', cursor: 1 }], redo: [{ text: 'r', cursor: 1 }], ...(anchor === undefined ? {} : { anchor }) }
	effects = []
}

// Situations a key can matter in: editing mid-text, with a selection,
// and an empty prompt while the model works.
const situations: (() => void)[] = [
	() => open({ type: 'idle' }, '\tab cd\nef gh\nij', 9),
	() => open({ type: 'idle' }, '\tab cd\nef gh\nij', 9, 2),
	() => {
		open({ type: 'running', phase: 'streaming' }, '', 0)
		app.onEvent({ type: 'turn-start', sessionId: 'k', prompt: 'last', provider: 'anthropic' } as Event)
		effects = []
	},
]

const event = (b: Binding): KeyEvent => ({ ...b, ...(b.key.length === 1 && !b.ctrl && !b.alt && !b.cmd ? { text: b.key } : {}) })

// Whether `b` does anything the user could see in some situation.
async function handled(b: Binding): Promise<boolean> {
	// The emergency keys never reach the app: raw stdin has them first.
	if (b.ctrl && !b.alt && !b.cmd && 'czr'.includes(b.key)) return emergency.scan(emergency.createState(), String.fromCharCode(b.key.charCodeAt(0) - 96)).length > 0
	for (let setup of situations) {
		app.reset()
		setup()
		let before = JSON.stringify(app.state)
		app.onKeys([event(b)])
		await Bun.sleep(0)
		if (effects.length || JSON.stringify(app.state) !== before) return true
	}
	return false
}

test('every binding /keys lists does something', async () => {
	let bindings = keyHelp.sections().flatMap((s) => s.rows.flatMap((r) => r.bindings))
	expect(bindings.length).toBeGreaterThan(40)
	let idle: string[] = []
	for (let b of bindings) if (!(await handled(b))) idle.push(JSON.stringify(b))
	expect(idle).toEqual([])
	// The check itself can tell: keys Hal leaves alone do nothing.
	for (let label of ['ctrl-q', 'ctrl-b', 'cmd-k', 'alt-x']) expect(await handled(keyHelp.parse(label))).toBe(false)
})

const cmd = (key: string): KeyEvent => ({ key, shift: false, alt: false, ctrl: false, cmd: true })
const ctrl = (key: string): KeyEvent => ({ key, shift: false, alt: false, ctrl: true, cmd: false })

test('Cmd-C copies the selection and keeps it; Cmd-X cuts it', async () => {
	open({ type: 'idle' }, 'one two', 7, 4)
	app.onKeys([cmd('c')])
	expect(app.state.prompt).toMatchObject({ text: 'one two', anchor: 4 })
	app.onKeys([cmd('x')])
	await Bun.sleep(0)
	expect(effects).toContain('copy two')
	expect(effects.filter((e) => e === 'copy two')).toHaveLength(2)
	expect(app.state.prompt).toMatchObject({ text: 'one ', cursor: 4 })
})

test('Ctrl-V and Cmd-V paste the clipboard, cleaned, over the selection', async () => {
	open({ type: 'idle' }, 'one two', 7, 4)
	clip = { text: 'a\r\nb\x1b' }
	app.onKeys([ctrl('v')])
	await Bun.sleep(0)
	expect(app.state.prompt).toMatchObject({ text: 'one a\nb', cursor: 7 })
	expect(effects).toContain('draft')
	app.onKeys([cmd('v')])
	await Bun.sleep(0)
	expect(app.state.prompt.text).toBe('one a\nba\nb')
})

test('a clipboard that fails shows a notice and keys go on working', async () => {
	open({ type: 'idle' }, 'x', 1)
	clip = { notice: 'no clipboard tool' }
	app.onKeys([ctrl('v'), { key: 'y', text: 'y', shift: false, alt: false, ctrl: false, cmd: false }])
	await Bun.sleep(0)
	expect(app.state.prompt.text).toBe('xy')
	expect(app.view().notice).toBe('no clipboard tool')
})

test('a paste that arrives after the tab changed is dropped', async () => {
	open({ type: 'idle' }, '', 0)
	app.onKeys([ctrl('v'), { key: '1', shift: false, alt: true, ctrl: false, cmd: false }])
	await Bun.sleep(0)
	expect(app.state.prompt.text).not.toContain('clip')
})
