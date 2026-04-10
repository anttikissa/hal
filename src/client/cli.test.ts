import { expect, test } from 'bun:test'
import { cli } from './cli.ts'

test('slash commands never route through steering', () => {
	expect(cli.submitCommandType('/help', false)).toBe('prompt')
	expect(cli.submitCommandType('/help', true)).toBe('prompt')
})

test('normal prompts steer only while busy', () => {
	expect(cli.submitCommandType('hello', false)).toBe('prompt')
	expect(cli.submitCommandType('hello', true)).toBe('steer')
})
