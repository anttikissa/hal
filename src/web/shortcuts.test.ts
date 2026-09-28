import { expect, test } from 'bun:test'
import { commandList } from '../common/commands/list.ts'
import { keyHelp } from '../common/key-help.ts'
import { shortcuts, type TabKey } from './shortcuts.ts'
import { view } from './view.ts'

const press = (key: string, mods: Partial<TabKey> = {}, mac = true) =>
	shortcuts.action({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods }, mac)

test('Alt-1..9 show that tab and Alt-0 the tenth, by physical key (macOS Alt types symbols)', () => {
	expect(press('¡', { altKey: true, code: 'Digit1' })).toEqual({ type: 'go', index: 0 })
	expect(press('9', { altKey: true, code: 'Digit9' }, false)).toEqual({ type: 'go', index: 8 })
	expect(press('º', { altKey: true, code: 'Digit0' })).toEqual({ type: 'go', index: 9 })
	expect(press('1', { code: 'Digit1' })).toBeUndefined()
	expect(press('a', { altKey: true, code: 'KeyA' })).toBeUndefined()
	expect(press('1', { altKey: true, ctrlKey: true, code: 'Digit1' })).toBeUndefined()
})

test('Ctrl-T/W/N/P are tab keys on macOS only; Cmd, Shift and IME composition are left alone', () => {
	expect(press('t', { ctrlKey: true })).toEqual({ type: 'new' })
	expect(press('w', { ctrlKey: true })).toEqual({ type: 'close' })
	expect(press('n', { ctrlKey: true })).toEqual({ type: 'next' })
	expect(press('p', { ctrlKey: true })).toEqual({ type: 'prev' })
	for (let key of 'twnp') expect(press(key, { ctrlKey: true }, false)).toBeUndefined()
	expect(press('t', { metaKey: true })).toBeUndefined()
	expect(press('T', { ctrlKey: true, shiftKey: true })).toBeUndefined()
	expect(press('m', { ctrlKey: true })).toBeUndefined()
	expect(press('1', { altKey: true, code: 'Digit1', isComposing: true })).toBeUndefined()
})

test('a command key the browser takes is not bound on the web; the others are', () => {
	let snapshot = { meta: { id: 's', cwd: '/', model: 'm', createdAt: '' }, history: [], state: { type: 'idle' as const } }
	let st = view.onEvent({}, { type: 'snapshot', sessionId: 's', snapshot })
	let event = (label: string) => {
		let b = keyHelp.parse(label)
		return { key: b.key === 'f1' ? 'F1' : b.key, shiftKey: b.shift, ctrlKey: b.ctrl, altKey: b.alt, metaKey: b.cmd }
	}
	let bound = (label: string, mac: boolean) => {
		let e = event(label)
		return !!shortcuts.action(e, mac) || !!view.commandKey(st, view.key(e)!, mac)
	}
	let taken = commandList.all().filter((c) => c.key && !commandList.onWeb(c.key, false))
	expect(taken.map((c) => c.key)).toContain('ctrl-t')
	for (let c of taken) expect(bound(c.key!, false)).toBe(false)
	expect(bound('ctrl-t', true)).toBe(true)
	expect(bound('ctrl-m', false)).toBe(true)
	expect(bound('f1', false)).toBe(true)
})
