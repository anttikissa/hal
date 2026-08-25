// Question-secret encryption prevents accidental disclosure through IPC, history,
// logs/debug inspection, and later LLM-provider context. It is not a sandbox
// against same-user arbitrary code or theft of the whole state directory. Remote
// use still requires HTTPS, which authenticates the server public key.

const MAX_PLAINTEXT_BYTES = 4_096

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid public key.')
	let binary: string
	try {
		binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
	} catch {
		throw new Error('Invalid public key.')
	}
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
	if (encodeBase64Url(bytes) !== value) throw new Error('Invalid public key.')
	return bytes
}

function additionalData(sessionId: string, questionId: string): Uint8Array<ArrayBuffer> {
	if (!sessionId || !questionId || sessionId.includes('\0') || questionId.includes('\0')) throw new Error('Invalid question scope.')
	return new TextEncoder().encode(`hal-question\0${sessionId}\0${questionId}`)
}

async function encryptSecret(publicKey: string, sessionId: string, questionId: string, plaintext: string): Promise<string> {
	const encoded = new TextEncoder().encode(plaintext)
	if (encoded.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('Question secrets are limited to 4096 bytes.')
	const rawPublicKey = decodeBase64Url(publicKey)
	if (rawPublicKey.byteLength !== 65 || rawPublicKey[0] !== 4) throw new Error('Invalid public key.')

	const serverPublicKey = await crypto.subtle.importKey('raw', rawPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
	const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
	const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPublicKey }, ephemeral.privateKey, 256)
	const aesKey = await crypto.subtle.importKey('raw', sharedSecret, 'AES-GCM', false, ['encrypt'])
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(sessionId, questionId), tagLength: 128 }, aesKey, encoded)
	const ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
	const packet = new Uint8Array(ephemeralPublicKey.byteLength + iv.byteLength + ciphertext.byteLength)
	packet.set(ephemeralPublicKey)
	packet.set(iv, ephemeralPublicKey.byteLength)
	packet.set(new Uint8Array(ciphertext), ephemeralPublicKey.byteLength + iv.byteLength)
	return encodeBase64Url(packet)
}

export const questionCrypto = { encryptSecret }
