// Question-secret encryption prevents accidental disclosure through IPC, history,
// logs/debug inspection, and later LLM-provider context. It is not a sandbox
// against same-user arbitrary code or theft of the whole state directory. Remote
// use still requires HTTPS, which authenticates the server public key.

const MAX_PLAINTEXT_BYTES = 190

async function encryptSecret(publicKey: string, plaintext: string): Promise<string> {
	const encoded = new TextEncoder().encode(plaintext)
	if (encoded.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('Question secrets are limited to 190 bytes.')
	const publicBytes = Uint8Array.from(atob(publicKey), (character) => character.charCodeAt(0))
	const key = await crypto.subtle.importKey('spki', publicBytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt('RSA-OAEP', key, encoded))
	return btoa(String.fromCharCode(...ciphertext))
}

export const questionCrypto = { encryptSecret }
