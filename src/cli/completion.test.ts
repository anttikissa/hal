import { expect, test } from 'bun:test'
import { completion } from './completion.ts'

test('/config completes as a command name', () => {
	const result = completion.complete('/con', '/con'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/config')
})

test('/help completes command topics', () => {
	const result = completion.complete('/help co', '/help co'.length)

	expect(result).not.toBeNull()
	expect(result!.items).toContain('/help config')
})
