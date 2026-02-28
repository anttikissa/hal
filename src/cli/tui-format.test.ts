import { describe, test, expect } from 'bun:test'
import { stripAnsi } from './format/index.ts'
import { buildStatusBarLine } from './tui/format/status-bar.ts'
import { buildPromptBlockFormatter } from './tui/format/prompt.ts'
import { applyStylePerLine } from './tui/format/line-style.ts'
import { styleLinePrefix } from './tui/format/line-prefix.ts'
import { loadActiveTheme } from './format/theme.ts'

const RESET = '\x1b[0m'

describe('tui formatter helpers', () => {
	test('status bar left/right alignment and truncation', () => {
		const line = buildStatusBarLine(30, '1 main  2 api', '42%/200k', 0)
		expect(stripAnsi(line).length).toBe(30)
		expect(stripAnsi(line)).toContain('42%/200k')

		const truncatedRight = buildStatusBarLine(8, 'tabs', 'very-long-right-side', 0)
		expect(stripAnsi(truncatedRight)).toBe('very-lon')
	})

	test('status bar preserves ANSI when truncating tabs from left', () => {
		const ACTIVE = '\x1b[97m'
		const INACTIVE = '\x1b[38;5;245m'
		// Build a wide tab string where the active tab is in the middle
		const tabs = `${INACTIVE} 1 t1 ${RESET}${INACTIVE} 2 t2 ${RESET}${ACTIVE}[3 t3]${RESET}${INACTIVE} 4 t4 ${RESET}`
		// Use narrow cols so the left side must be truncated
		const line = buildStatusBarLine(30, tabs, 'right', 0)
		// The active tab ANSI code must survive truncation
		expect(line).toContain(ACTIVE)
		expect(line).toContain('[3 t3]')
	})

	test('status bar output always appends reset code', () => {
		const line = buildStatusBarLine(20, 'tabs', 'right', 0)
		expect(line.endsWith(RESET)).toBe(true)
	})

	test('prompt formatter applies side padding on every wrapped line', () => {
		loadActiveTheme(process.cwd(), 'default')
		const fmt = buildPromptBlockFormatter(12)
		const rendered = fmt.formatText('alpha beta gamma')
		const plainLines = stripAnsi(rendered).split('\n')

		expect(plainLines.length).toBe(2)
		for (const line of plainLines) {
			expect(line.startsWith(' ')).toBe(true)
			expect(line.endsWith(' ')).toBe(true)
		}
	})

	test('applyStylePerLine styles each wrapped/newline-separated line', () => {
		const styled = applyStylePerLine('\x1b[33m', 'line1\nline2')
		expect(styled).toBe('\x1b[33mline1\x1b[0m\n\x1b[33mline2\x1b[0m')
	})

	test('styleLinePrefix preserves style on text after prefix reset', () => {
		loadActiveTheme(process.cwd(), 'default')
		const styled = styleLinePrefix('line.tool', '[tool] hello')
		expect(styled).toContain('\x1b[0m\x1b[36mhello')
	})
})
