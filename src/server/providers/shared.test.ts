import { expect, test } from 'bun:test'
import { providerShared } from './shared.ts'

test('parseToolInput reports where the model broke the JSON', () => {
	// Real payload from a Claude stream: it pasted a hashline ref (205:wDF) into an
	// integer field, so the model needs to see which token was rejected.
	const { input, parseError } = providerShared.parseToolInput('{"path": "mail.test.ts", "start": 205:wDF, "end": 264}')

	expect(input).toEqual({})
	expect(parseError).toContain('1:38')
	expect(parseError).toContain('205:wDF')
})

test('parseToolInput rejects a tool call that streamed no arguments', () => {
	// An argument-less tool_use block used to become a valid-looking empty call.
	const { parseError } = providerShared.parseToolInput('')

	expect(parseError).toBeTruthy()
})

test('parseToolInput accepts well-formed arguments', () => {
	const { input, parseError } = providerShared.parseToolInput('{"path": "a.ts", "start": 1}')

	expect(input).toEqual({ path: 'a.ts', start: 1 })
	expect(parseError).toBeUndefined()
})
