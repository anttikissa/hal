import { expect, test } from 'bun:test'
import { reasoningSignature } from './reasoning-signature.ts'

test('minimize drops duplicated reasoning summary text', () => {
	const full = JSON.stringify({
		type: 'reasoning',
		id: 'rs_123',
		encrypted_content: 'secret',
		summary: [{ type: 'summary_text', text: 'duplicate' }],
	})

	expect(reasoningSignature.minimize(full)).toBe(JSON.stringify({
		type: 'reasoning',
		id: 'rs_123',
		encrypted_content: 'secret',
	}))
})

test('parse accepts minimized reasoning signatures', () => {
	const minimized = JSON.stringify({
		type: 'reasoning',
		encrypted_content: 'secret',
	})

	expect(reasoningSignature.parse(minimized)).toEqual({
		type: 'reasoning',
		id: undefined,
		encrypted_content: 'secret',
	})
})
