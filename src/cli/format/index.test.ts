import { describe, test, expect } from 'bun:test'
import { pushFragment, resetFormat } from './index.ts'
import { loadActiveTheme } from './theme.ts'

const RESET = '\x1b[0m'

describe('cli format index', () => {
	test('chunk transition prefix uses RESET first and newline between channels', () => {
		resetFormat('s1')
		const first = pushFragment('chunk.assistant', 'hello', 's1')
		expect(first.startsWith(RESET)).toBe(true)

		const secondSameKind = pushFragment('chunk.assistant', 'world', 's1')
		expect(secondSameKind.startsWith('\n')).toBe(false)
		expect(secondSameKind.startsWith(RESET)).toBe(false)

		const thirdDifferentKind = pushFragment('chunk.thinking', 'hmm', 's1')
		expect(thirdDifferentKind.startsWith('\n')).toBe(true)
	})

	test('line styles are applied per line including multi-line content', () => {
		loadActiveTheme(process.cwd(), 'default')
		resetFormat('s2')
		const out = pushFragment('line.warn', 'one\ntwo', 's2')
		expect(out).toContain('\x1b[33mone\x1b[0m\n\x1b[33mtwo\x1b[0m')
		expect(out.endsWith('\n')).toBe(true)
	})

	test('prefix styling keeps remainder styled after prefix reset', () => {
		loadActiveTheme(process.cwd(), 'default')
		resetFormat('s3')
		const out = pushFragment('line.tool', '[tool] done', 's3')
		expect(out).toContain('\x1b[0m\x1b[36mdone')
	})
})
