import { expect, test } from 'bun:test'
import { cli } from './cli.ts'

test('read-only slash commands never route through steering', () => {
	expect(cli.submitCommandType('/help', false)).toBe('prompt')
	expect(cli.submitCommandType('/help', true)).toBe('prompt')
})

test('model changes steer while busy so the old turn gets aborted first', () => {
	expect(cli.submitCommandType('/model gpt-5.4', false)).toBe('prompt')
	expect(cli.submitCommandType('/model gpt-5.4', true)).toBe('steer')
})

test('normal prompts steer only while busy', () => {
	expect(cli.submitCommandType('hello', false)).toBe('prompt')
	expect(cli.submitCommandType('hello', true)).toBe('steer')
})
