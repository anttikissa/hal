// Settings modal key handling and inline value validation.
import { expect, test } from 'bun:test'
import { settingsModal } from './settings-modal.ts'

const data = { values: { push: 'true', security: 'best-effort', webPort: '9001' }, stored: {} }
const key = (k: string) => ({ key: k, ...(k.length === 1 && { text: k }) })

function at(name: string) {
	let st = settingsModal.open(data)
	return { ...st, selected: st.settings!.names.indexOf(name) }
}

test('Space and Enter change a setting at once and keep the modal open', () => {
	expect(settingsModal.step(at('push'), key(' '), 's').action).toEqual({
		type: 'send',
		command: { type: 'submit', sessionId: 's', text: '/config push false' },
	})
	expect(settingsModal.step(at('security'), key('enter'), 's').action).toMatchObject({
		command: { text: '/config security none' },
	})
})

test('an edit sends only a valid value; Escape restores without sending', () => {
	let st = settingsModal.step(at('webPort'), key('enter'), 's').state
	st = settingsModal.step(st, key('x'), 's').state
	let refused = settingsModal.step(st, key('enter'), 's')
	expect(refused.action).toBeUndefined()
	expect(refused.state.error).toContain('webPort')
	expect(refused.state.edit).toBeDefined()
	let back = settingsModal.step(refused.state, key('escape'), 's')
	expect(back.action).toBeUndefined()
	expect(back.state.edit).toBeUndefined()
	st = settingsModal.step(at('webPort'), key('enter'), 's').state
	for (let k of ['backspace', '2']) st = settingsModal.step(st, key(k), 's').state
	expect(settingsModal.step(st, key('enter'), 's').action).toMatchObject({ command: { text: '/config webPort 9002' } })
})

test('Left and Right adjust integers and booleans without crossing bounds', () => {
	for (let [name, now, left, right] of [
		['webPort', '9001', '9000', '9002'],
		['webPort', '1', undefined, '2'],
		['webPort', '65535', '65534', undefined],
		['push', 'true', 'false', undefined],
		['push', 'false', undefined, 'true'],
	] as const) {
		let st = at(name)
		st.settings!.values = { ...data.values, [name]: now }
		for (let [arrow, value] of [
			['left', left],
			['right', right],
		] as const) {
			let result = settingsModal.step(st, key(arrow), 's')
			expect(result.state).toBe(st)
			if (value === undefined) expect(result.action).toBeUndefined()
			else expect(result.action).toMatchObject({ command: { text: `/config ${name} ${value}` } })
		}
	}
	for (let st of [at('model'), at('security'), settingsModal.step(at('webPort'), key('enter'), 's').state]) {
		expect(settingsModal.step(st, key('right'), 's').action).toBeUndefined()
	}
	expect(settingsModal.step(at('webPort'), { key: 'right', ctrl: true }, 's').action).toBeUndefined()
})
