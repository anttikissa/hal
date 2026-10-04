import { afterEach, beforeEach, expect, test } from 'bun:test'
import { commandList } from '../common/commands/list.ts'
import { drafts } from '../common/drafts.ts'
import { keyHelp } from '../common/key-help.ts'
import type { Snapshot, Tab } from '../common/protocol.ts'
import { app } from './app.ts'
import { clientCommands } from './commands.ts'
import { render } from './render.ts'
import { terminal, type TerminalIO } from './terminal.ts'

let sent: any[] = []
let ran: string[] = []
const saved = { send: app.send, show: render.show, draftSend: drafts.send, all: { ...clientCommands.all } }

beforeEach(() => {
	sent = []
	ran = []
	app.reset()
	app.send = (c: any) => sent.push(c)
	drafts.send = () => {}
	render.show = () => {}
	for (let name of Object.keys(clientCommands.all)) clientCommands.all[name] = { run: () => ran.push(name) }
})

afterEach(() => {
	Object.assign(app, { send: saved.send })
	drafts.send = saved.draftSend
	render.show = saved.show
	Object.assign(clientCommands.all, saved.all)
	terminal.reset()
	app.reset()
})

const tab = (id: string): Tab => ({ id, name: id, cwd: `/${id}`, model: 'm', state: { type: 'idle' } })

function open(): void {
	app.onEvent({ type: 'tabs', tabs: [tab('a'), tab('b')] })
	app.onEvent({ type: 'ack', id: 'x', tab: 'a' })
	let snap: Snapshot = { meta: { id: 'a', cwd: '/', model: 'anthropic/x', createdAt: '' }, history: [], state: { type: 'idle' } }
	app.onEvent({ type: 'snapshot', sessionId: 'a', snapshot: snap })
	sent = []
}

const emergency = ['quit', 'suspend', 'restart']

test('each command key runs its command, the prompt left alone', () => {
	let keyed = commandList.all().filter((c) => c.key && !emergency.includes(c.name))
	expect(keyed.length).toBeGreaterThan(4)
	for (let c of keyed) {
		open()
		app.state.prompt = { ...app.state.prompt, text: 'draft', cursor: 5 }
		ran = []
		app.onKeys([keyHelp.parse(c.key!)])
		if (c.name === 'find') { expect(app.state.modal?.find).toBeDefined(); expect(sent).toEqual([]); app.close(); sent = [] }
		else if (clientCommands.all[c.name]) expect(ran).toEqual([c.name])
		else expect(sent).toEqual([c.name === 'model' ? { type: 'models', sessionId: 'a' } : { type: 'submit', sessionId: 'a', text: `/${c.name}` }])
		expect(app.state.prompt.text).toBe('draft')
	}
})

test('every command key shows in /keys', () => {
	let shown = keyHelp.sections().flatMap((s) => s.rows)
	for (let c of commandList.all().filter((c) => c.key)) expect(shown.find((r) => r.keys === c.key)?.command).toBe(c.keyArgs ? `${c.name} ${c.keyArgs}` : c.name)
})

test('typed client-only commands run here and never reach the host', () => {
	open()
	for (let [text, name] of [['/quit', 'quit'], ['/restart local', 'restart'], ['/suspend', 'suspend'], ['/redraw', 'redraw']] as const) {
		ran = []
		expect(app.submit(text)).toBe(true)
		expect(ran).toEqual([name])
	}
	expect(sent.filter((c) => c.type === 'submit')).toEqual([])
})

test('typed /restart local exits with the restart code, like Ctrl-R; bare goes to the host', () => {
	Object.assign(clientCommands.all, saved.all)
	let codes: number[] = []
	let io = { exit: (c: number) => codes.push(c), write: () => {}, setRawMode: () => {} } as unknown as TerminalIO
	terminal.state.io = io
	terminal.onData('\x12')
	app.submit('/restart local')
	expect(codes).toEqual([terminal.restartCode, terminal.restartCode])
	expect(clientCommands.typed('/restart')).toBe(false)
})
