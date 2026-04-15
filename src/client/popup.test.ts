import { beforeEach, describe, expect, test } from 'bun:test'
import { colors } from '../cli/colors.ts'
import { popup } from './popup.ts'
import { visLen } from '../utils/strings.ts'
import type { KeyEvent } from '../cli/keys.ts'

colors.init()
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


	test('model picker starts with the current model selected', () => {
		popup.openModelPicker(() => {}, 'openai/gpt-5.4')
		expect(popup.state.items[popup.state.selectedIndex]?.value).toBe('gpt')
		const overlay = popup.buildOverlay(120, 30)
		expect(overlay).not.toBeNull()
		const selectedLine = overlay!.lines.find((line) => line.includes('GPT 5.4'))
		expect(colors.popup.current.bg).not.toBe('')
		expect(colors.popup.current.fg).not.toBe('')
		expect(selectedLine).toContain(colors.popup.current.bg)
		expect(selectedLine).toContain(colors.popup.current.fg)
	})

	test('warning popup uses the same highlighted row layout', () => {
		popup.openConfirm('Looks suspicious', ['read auth.ason'], ['Yes', 'No'], () => {})
		const overlay = popup.buildOverlay(80, 24)
		expect(overlay).not.toBeNull()
		expect(overlay?.lines.join('\n')).toContain('[Yes]')
	})


	test('model picker keeps a stable width while filtering', () => {
		popup.openModelPicker(() => {})
		const before = popup.buildOverlay(120, 30)
		expect(before).not.toBeNull()
		popup.handleKey({ key: 'l', char: 'l', shift: false, alt: false, ctrl: false, cmd: false })
		popup.handleKey({ key: 'l', char: 'l', shift: false, alt: false, ctrl: false, cmd: false })
		const after = popup.buildOverlay(120, 30)
		expect(after).not.toBeNull()
		expect(visLen(after!.lines[0]!)).toBe(visLen(before!.lines[0]!))
	})

	test('popup keeps a safety margin away from terminal edges', () => {
		popup.openModelPicker(() => {})
		const overlay = popup.buildOverlay(40, 24)
		expect(overlay).not.toBeNull()
		expect(Math.max(...overlay!.lines.map((line) => visLen(line)))).toBeLessThan(40)
		expect(overlay!.y + overlay!.lines.length).toBeLessThan(24)
	})
})
