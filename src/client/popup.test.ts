import { beforeEach, describe, expect, test } from 'bun:test'
import { popup } from './popup.ts'
import type { KeyEvent } from '../cli/keys.ts'

function key(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

beforeEach(() => {
	popup.close()
})

describe('popup', () => {
	test('model picker filters with its input editor and confirms the selected model', () => {
		let picked = ''
		popup.openModelPicker((value) => {
			picked = value
		})
		popup.handleKey({ key: 's', char: 's', shift: false, alt: false, ctrl: false, cmd: false })
		popup.handleKey({ key: 'o', char: 'o', shift: false, alt: false, ctrl: false, cmd: false })
		popup.handleKey({ key: 'n', char: 'n', shift: false, alt: false, ctrl: false, cmd: false })
		expect(popup.state.active).toBe(true)
		expect(popup.state.items[0]?.value).toBe('sonnet')
		popup.handleKey(key('enter'))
		expect(picked).toBe('sonnet')
		expect(popup.state.active).toBe(false)
	})

	test('warning popup uses the same highlighted row layout', () => {
		popup.openConfirm('Looks suspicious', ['read auth.ason'], ['Yes', 'No'], () => {})
		const overlay = popup.buildOverlay(80, 24)
		expect(overlay).not.toBeNull()
		expect(overlay?.lines.join('\n')).toContain('[Yes]')
	})
})
