import { beforeEach, describe, expect, test } from 'bun:test'
import { colors } from './colors.ts'
import { popup } from './popup.ts'
import { visLen } from '../../utils/strings.ts'
import type { KeyEvent } from './keys.ts'
import { models } from '../../common/models.ts'

colors.init()
function key(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
}

function cleanLines(lines: string[]): string[] {
	return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
}

beforeEach(() => {
	popup.close()
	models.state.cache = {}
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
		expect(popup.state.items[popup.state.selectedIndex]?.value).toBe('category:anthropic/sonnet')
		popup.handleKey(key('enter'))
		expect(picked).toBe('sonnet')
		expect(popup.state.active).toBe(false)
	})

	test('model picker filtering keeps hierarchy and selects first matching row', () => {
		popup.openModelPicker(() => {}, 'anthropic/claude-opus-4-7')
		models.state.cache = { 'claude-opus-4-8': 1_000_000, 'claude-opus-4-7': 1_000_000, 'claude-opus-4-6': 1_000_000 }
		popup.state.selectedIndex = 5
		for (const ch of 'opus') popup.handleKey({ key: ch, char: ch, shift: false, alt: false, ctrl: false, cmd: false })
		expect(popup.state.items[popup.state.selectedIndex]?.value).toBe('category:anthropic/opus')
		const clean = cleanLines(popup.buildOverlay(120, 30)!.lines).join('\n')
		expect(clean).toContain('▼ anthropic')
		expect(clean).toContain('▼ opus')
		expect(clean).toContain('opus-4-8')
		expect(clean).not.toContain('fable')
	})


	test('model picker selects the visible GPT version for older GPT sessions', () => {
		popup.openModelPicker(() => {}, 'openai/gpt-5.4')
		expect(popup.state.items[popup.state.selectedIndex]?.value).toBe('gpt-5.4')
		const overlay = popup.buildOverlay(120, 30)
		expect(overlay).not.toBeNull()
		const selectedLine = overlay!.lines.find((line) => line.includes('GPT 5.4'))
		expect(cleanLines([selectedLine ?? ''])[0]).toContain(' 5.4          GPT 5.4')
		expect(cleanLines([selectedLine ?? ''])[0]).not.toContain('[')
		expect(colors.popup.current.bg).not.toBe('')
		expect(colors.popup.current.fg).not.toBe('')
		expect(selectedLine).toContain(colors.popup.current.bg)
		expect(selectedLine).toContain(colors.popup.current.fg)
	})

	test('model picker shows tree hints and opens or closes categories with arrows', () => {
		models.state.cache = {
			'claude-sonnet-4-5': 1_000_000,
		}
		popup.openModelPicker(() => {}, 'anthropic/claude-opus-4-8')
		let overlay = popup.buildOverlay(120, 30)
		expect(overlay).not.toBeNull()
		let clean = cleanLines(overlay!.lines).join('\n')
		expect(clean).toContain('←/→: open/close category')
		expect(visLen('▶')).toBe(1)
		expect(clean).toContain('Pick a model (current: anthropic/claude-opus-4-8)')
		expect(clean).toContain('▶ anthropic (default: opus-5)')
		expect(clean).not.toContain('Sonnet 5')

		popup.state.selectedIndex = popup.state.items.findIndex((item) => item.label.includes('anthropic'))
		popup.handleKey(key('right'))
		overlay = popup.buildOverlay(120, 30)
		clean = cleanLines(overlay!.lines).join('\n')
		expect(clean).toContain('▼ anthropic (default: opus-5)')
		expect(clean).toContain('▶ sonnet (default: sonnet-5)')

		popup.handleKey(key('left'))
		overlay = popup.buildOverlay(120, 30)
		clean = cleanLines(overlay!.lines).join('\n')
		expect(clean).toContain('▶ anthropic (default: opus-5)')
		expect(clean).not.toContain('Sonnet 5')
		expect(clean).not.toContain('Sonnet 4.5')
	})

	test('model picker enter on categories picks defaults and left on models closes their category', () => {
		models.state.cache = { 'gpt-5.6': 1_200_000, 'gpt-5.5': 1_050_000 }
		let picked = ''
		popup.openModelPicker((value) => {
			picked = value
		}, 'openai/gpt-5.5')
		popup.state.selectedIndex = popup.state.items.findIndex((item) => item.label.includes('openai'))
		let overlay = popup.buildOverlay(120, 30)
		let clean = cleanLines(overlay!.lines).join('\n')
		expect(clean).toContain('enter: pick default')
		expect(clean).toContain('▼ openai (default: gpt-5.6-terra)')
		popup.handleKey(key('enter'))
		expect(picked).toBe('gpt')
		expect(popup.state.active).toBe(false)

		popup.openModelPicker(() => {}, 'openai/gpt-5.5')
		popup.state.selectedIndex = popup.state.items.findIndex((item) => item.value === 'gpt-5.4')
		popup.handleKey(key('left'))
		overlay = popup.buildOverlay(120, 30)
		clean = cleanLines(overlay!.lines).join('\n')
		expect(popup.state.items[popup.state.selectedIndex]?.label).toContain('gpt')
		expect(clean).toContain('▶ gpt (default: gpt-5.6-terra)')
		expect(clean).not.toContain('GPT 5.4')
		popup.openModelPicker(() => {}, 'anthropic/claude-opus-4-8')
		popup.state.selectedIndex = popup.state.items.findIndex((item) => item.label.includes('sonnet'))
		popup.handleKey(key('left'))
		overlay = popup.buildOverlay(120, 30)
		clean = cleanLines(overlay!.lines).join('\n')
		expect(clean).toContain('▶ anthropic')
		expect(clean).not.toContain('sonnet')
	})

	test('model picker has outer breathing room and puts hint in bottom border', () => {
		popup.openModelPicker(() => {}, 'anthropic/claude-fable-5')
		const overlay = popup.buildOverlay(120, 30)
		expect(overlay).not.toBeNull()
		const clean = cleanLines(overlay!.lines)
		expect(clean[1]).toMatch(/^│ +│$/)
		expect(clean[clean.length - 2]).toMatch(/^│ +│$/)
		expect(clean[clean.length - 1]).toContain('←/→: open/close category')
		expect(clean[0]).toContain('current: anthropic/claude-fable-5')
	})

	test('model picker cursor stays on the input row after outer padding', () => {
		popup.openModelPicker(() => {}, 'openai/gpt-5.5')
		popup.handleKey({ key: 'o', char: 'o', shift: false, alt: false, ctrl: false, cmd: false })
		popup.handleKey({ key: 'p', char: 'p', shift: false, alt: false, ctrl: false, cmd: false })
		const overlay = popup.buildOverlay(120, 30)
		expect(overlay?.cursor).not.toBeNull()
		const clean = cleanLines(overlay!.lines)
		expect(clean[overlay!.cursor!.row - overlay!.y]).toContain('> op')
	})

	test('model picker marks the current model row', () => {
		popup.openModelPicker(() => {}, 'anthropic/claude-opus-5')
		popup.state.selectedIndex = 0
		const overlay = popup.buildOverlay(120, 30)
		const clean = cleanLines(overlay!.lines).join('\n')
		expect(clean).toContain('*      5.0          Opus 5 · anthropic/claude-opus-5')
		expect(overlay!.lines.find((line) => line.includes('Opus 5'))).toContain(colors.popup.modelCurrent.bg)
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
