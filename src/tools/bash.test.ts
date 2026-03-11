import { test, expect } from 'bun:test'
import { bash } from './bash.ts'

test('formatBlock keeps short command inline', () => {
	const view = bash.formatBlock({
		command: 'echo hello',
		status: 'done',
		elapsed: '1.0s',
		output: 'hello\n',
		commandWidth: 40,
		maxOutputLines: 5,
	})
	expect(view.label).toBe('bash: echo hello (1.0s) ✓')
	expect(view.commandLines).toEqual([])
	expect(view.outputLines).toEqual(['hello'])
	expect(view.hiddenOutputLines).toBe(0)
})

test('formatBlock moves long command below header with continuation', () => {
	const view = bash.formatBlock({
		command: 'echo ' + 'x'.repeat(80),
		status: 'running',
		elapsed: '0.4s',
		output: '',
		commandWidth: 24,
		maxOutputLines: 5,
	})
	expect(view.label).toBe('bash: (0.4s) …')
	expect(view.commandLines.length).toBeGreaterThan(1)
	expect(view.commandLines[0]).toEndWith(' \\')
	expect(view.hiddenOutputLines).toBe(0)
})

test('formatBlock truncates output from the head', () => {
	const output = Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join('\n')
	const view = bash.formatBlock({
		command: 'echo many',
		status: 'done',
		elapsed: '2.0s',
		output,
		commandWidth: 30,
		maxOutputLines: 3,
	})
	expect(view.hiddenOutputLines).toBe(4)
	expect(view.outputLines).toEqual(['line 5', 'line 6', 'line 7'])
})
