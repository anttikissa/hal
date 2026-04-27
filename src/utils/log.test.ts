import { afterEach, expect, test } from 'bun:test'
import { log } from './log.ts'

const originalLevel = log.config.level

afterEach(() => {
	log.config.level = originalLevel
})

test('debug logging can be enabled at runtime', () => {
	log.config.level = ''
	expect(log.isEnabled('debug')).toBe(false)
	expect(log.isEnabled('info')).toBe(false)

	log.config.level = 'debug'
	expect(log.isEnabled('debug')).toBe(true)
	expect(log.isEnabled('info')).toBe(true)
	expect(log.isEnabled('error')).toBe(true)
})

test('info logging skips debug messages', () => {
	log.config.level = 'info'

	expect(log.isEnabled('debug')).toBe(false)
	expect(log.isEnabled('info')).toBe(true)
	expect(log.isEnabled('error')).toBe(true)
})
