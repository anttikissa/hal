import { describe, test, expect } from 'bun:test'
import { buildPromptBlockFormatter } from './prompt.ts'
import { loadActiveTheme } from '../../format/theme.ts'

const RESET = '\x1b[0m'
const CLEAR_EOL = '\x1b[K'
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, '')
}

describe('buildPromptBlockFormatter', () => {
	test('normal prompt has block structure with bar', () => {
		const fmt = buildPromptBlockFormatter(80)
		expect(fmt.blockStart).toContain(CLEAR_EOL)
		expect(fmt.blockEnd).toContain(CLEAR_EOL)
		const text = fmt.formatText('hello')
		expect(stripAnsi(text)).toContain('hello')
	})

	test('steering prompt has block structure with bar', () => {
		const fmt = buildPromptBlockFormatter(80, true)
		expect(fmt.blockStart).toContain(CLEAR_EOL)
		expect(fmt.blockEnd).toContain(CLEAR_EOL)
		const text = fmt.formatText('hello')
		expect(stripAnsi(text)).toContain('hello')
	})

	test('normal and steering formatters produce different ANSI output with hal theme', () => {
		loadActiveTheme(process.cwd(), 'hal')
		const normal = buildPromptBlockFormatter(80, false)
		const steering = buildPromptBlockFormatter(80, true)

		const normalText = normal.formatText('test')
		const steeringText = steering.formatText('test')

		// Both contain the text
		expect(stripAnsi(normalText)).toContain('test')
		expect(stripAnsi(steeringText)).toContain('test')

		// But ANSI codes differ (different text style)
		expect(normalText).not.toBe(steeringText)
	})

	test('normal and steering formatters produce different output with default theme', () => {
		loadActiveTheme(process.cwd(), 'default')
		const normal = buildPromptBlockFormatter(80, false)
		const steering = buildPromptBlockFormatter(80, true)

		const normalText = normal.formatText('test')
		const steeringText = steering.formatText('test')

		expect(stripAnsi(normalText)).toContain('test')
		expect(stripAnsi(steeringText)).toContain('test')
		expect(normalText).not.toBe(steeringText)
	})
})
