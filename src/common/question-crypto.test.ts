import { expect, test } from 'bun:test'
import { questionCrypto } from './question-crypto.ts'

test('question encryption rejects malformed server keys and RSA-OAEP oversized plaintext', async () => {
	await expect(questionCrypto.encryptSecret('invalid', 'secret')).rejects.toThrow()
	await expect(questionCrypto.encryptSecret('invalid', 'x'.repeat(191))).rejects.toThrow(/190/)
	await expect(questionCrypto.encryptSecret('invalid', 'é'.repeat(96))).rejects.toThrow(/190/)
})
