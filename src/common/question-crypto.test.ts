import { expect, test } from 'bun:test'
import { questionCrypto } from './question-crypto.ts'

const publicKey = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

test('question encryption rejects malformed server keys, ambiguous AAD, and oversized plaintext', async () => {
	await expect(questionCrypto.encryptSecret(publicKey, 'session', 'question', 'secret')).rejects.toThrow()
	await expect(questionCrypto.encryptSecret(publicKey, 'session\0other', 'question', 'secret')).rejects.toThrow()
	await expect(questionCrypto.encryptSecret(publicKey, 'session', 'question', 'x'.repeat(4_097))).rejects.toThrow(/4096/)
})
