import { beforeEach, describe, expect, test } from 'bun:test'
import { colors } from '../cli/colors.ts'
import { popup } from './popup.ts'
import { visLen } from '../utils/strings.ts'
import type { KeyEvent } from '../cli/keys.ts'
import { models } from '../models.ts'

colors.init()
function key(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
	return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods }
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
		expect(popup.state.items[0]?.value).toBe('sonnet')
		popup.handleKey(key('enter'))
		expect(picked).toBe('sonnet')
		expect(popup.state.active).toBe(false)
	})


	test('model picker selects the visible GPT version for older GPT sessions', () => {
		popup.openModelPicker(() => {}, 'openai/gpt-5.4')
		expect(popup.state.items[popup.state.selectedIndex]?.value).toBe('gpt-5.4')
		const overlay = popup.buildOverlay(120, 30)
		expect(overlay).not.toBeNull()
		const selectedLine = overlay!.lines.find((line) => line.includes('GPT 5.4'))
		expect(colors.popup.current.bg).not.toBe('')
		expect(colors.popup.current.fg).not.toBe('')
		expect(selectedLine).toContain(colors.popup.current.bg)
		expect(selectedLine).toContain(colors.popup.current.fg)
	})

	test('model picker shows tree hints and opens or closes categories with arrows', () => {
		models.state.cache = {
			'claude-sonnet-4-5': 1_000_000,
		}
		popup.openModelPicker(() => {})
		let overlay = popup.buildOverlay(120, 30)
		expect(overlay).not.toBeNull()
		let clean = overlay!.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
		expect(clean).toContain('right opens category')
		expect(clean).toContain('left closes category')
		expect(clean).toContain('▸ sonnet')
		expect(clean).not.toContain('Sonnet 4.5')

		popup.state.selectedIndex = popup.state.items.findIndex((item) => item.label.includes('sonnet'))
		popup.handleKey(key('right'))
		overlay = popup.buildOverlay(120, 30)
		clean = overlay!.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
		expect(clean).toContain('▾ sonnet')
		expect(clean).toContain('Sonnet 4.5')

		popup.handleKey(key('left'))
		overlay = popup.buildOverlay(120, 30)
		clean = overlay!.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
		expect(clean).toContain('▸ sonnet')
		expect(clean).not.toContain('Sonnet 4.5')
	})

	test('warning popup uses the same highlighted row layout', () => {
		popup.openConfirm('Looks suspicious', ['read auth.ason'], ['Yes', 'No'], () => {})
		const overlay = popup.buildOverlay(80, 24)
		expect(overlay).not.toBeNull()
		expect(overlay?.lines.join('\n')).toContain('[Yes]')
		expect(overlay?.lines[0]).toContain(colors.popup.warningFg)
	})

	test('danger confirm popup wraps long lines instead of truncating them', () => {
		// A single long line that exceeds the popup width must be wrapped, not clipped with '…'.
		const longTail = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
		popup.openConfirm('Risky tool call', [`start ${longTail} end`], ['Yes', 'No'], () => {}, 'danger')
		const overlay = popup.buildOverlay(60, 40)
		const clean = overlay!.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
		expect(clean.join('\n')).not.toContain('…')
		expect(clean.some((line) => line.includes('end'))).toBe(true)
	})

	test('confirm popup splits body lines that contain embedded newlines', () => {
		const body = ['Session x (tab 1) wants to do this:', '', 'bash:', "python3 - <<'PY'\nfrom pathlib import Path\np=Path('hello')\nPY"]
		popup.openConfirm('Risky tool call', body, ['Yes', 'No'], () => {}, 'danger')
		const overlay = popup.buildOverlay(100, 40)
		const clean = overlay!.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
		for (let i = 1; i < clean.length - 1; i++) {
			expect(clean[i]).toMatch(/^│.*│$/)
		}
		expect(clean.some((line) => line.includes("python3 - <<'PY'"))).toBe(true)
		expect(clean.some((line) => line.includes('from pathlib import Path'))).toBe(true)
		expect(clean.some((line) => line.includes("p=Path('hello')"))).toBe(true)
	})

	test('confirm popup clips tall body with the standard hidden-lines indicator', () => {
		const body = ['start']
		for (let i = 0; i < 30; i++) body.push(`body line ${i}`)
		body.push('important reason at the bottom')
		popup.openConfirm('Risky tool call', body, ['Yes', 'No'], () => {}, 'danger')
		const overlay = popup.buildOverlay(80, 12)
		expect(overlay).not.toBeNull()
		expect(overlay!.y + overlay!.lines.length).toBeLessThan(12)
		for (const line of overlay!.lines) expect(visLen(line)).toBeLessThan(80)
		const clean = overlay!.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
		expect(clean).toContain('[+ ')
		expect(clean).toContain(' lines]')
		expect(clean).toContain('start')
		expect(clean).toContain('important reason at the bottom')
		expect(clean).toContain('[Yes]')
		expect(clean).toContain(' No')
	})

	test('confirm popup gives text horizontal and vertical breathing room', () => {
		popup.openConfirm('Claude cache likely cold', ['Sending this may write 170k tokens.'], ['Send anyway', 'Cancel'], () => {})
		const overlay = popup.buildOverlay(100, 30)
		expect(overlay).not.toBeNull()
		const clean = overlay!.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
		const bodyIndex = clean.findIndex((line) => line.includes('Sending this may write'))
		expect(bodyIndex).toBeGreaterThan(0)
		expect(clean[bodyIndex]).toContain('│ Sending this may write 170k tokens.')
		expect(clean[bodyIndex - 1]).toMatch(/^│ +│$/)
		expect(clean[bodyIndex + 1]).toMatch(/^│ +│$/)
		const choiceIndex = clean.findIndex((line) => line.includes('Send anyway'))
		expect(choiceIndex).toBeGreaterThan(bodyIndex)
		// Bottom border is the last row; require an empty padding row right above it.
		expect(clean[clean.length - 2]).toMatch(/^│ +│$/)
		expect(choiceIndex).toBeLessThan(clean.length - 2)
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
