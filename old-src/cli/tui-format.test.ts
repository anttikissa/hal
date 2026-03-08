import { describe, test, expect } from 'bun:test'
import { stripAnsi } from './format/index.ts'
import { buildStatusBarLine } from './tui/format/status-bar.ts'

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
		const tabs = `${INACTIVE} 1 t1 ${RESET}${INACTIVE} 2 t2 ${RESET}${ACTIVE}[3 t3]${RESET}${INACTIVE} 4 t4 ${RESET}`
		const line = buildStatusBarLine(30, tabs, 'right', 0)
		expect(line).toContain(ACTIVE)
		expect(line).toContain('[3 t3]')
	})

	test('status bar output always appends reset code', () => {
		const line = buildStatusBarLine(20, 'tabs', 'right', 0)
		expect(line.endsWith(RESET)).toBe(true)
	})
})
