// Question-secret encryption prevents accidental disclosure through IPC, history,
// logs/debug inspection, and later LLM-provider context. It is not a sandbox
// against same-user arbitrary code or theft of the whole state directory. Remote
// use still requires HTTPS, which authenticates the server public key.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, timingSafeEqual } from 'crypto'
import { liveFiles } from '../utils/live-file.ts'
import { STATE_DIR } from './state.ts'

export type WebToken = {
	token: string
	purpose: string
	createdAt: string
	lastUsedAt?: string
	lastUsedIp?: string
}

type QuestionKey = {
	publicKey: string
	privateKey: string
}

type ServerKeyStore = {
	tokens: WebToken[]
	questionKey?: QuestionKey
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const MAX_PACKET_BYTES = 65 + 12 + 4_096 + 16
const MAX_PACKET_LENGTH = Math.ceil(MAX_PACKET_BYTES * 4 / 3)

const config = {
	path: `${STATE_DIR}/server-keys.ason`,
}

const state: { initialized: boolean; store: ServerKeyStore | null } = {
	initialized: false,
	store: null,
}

const revokeListeners = new Set<(token: WebToken) => void>()

function publicKeyFromPrivate(privateKey: string): Buffer {
	const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
	const jwk = createPublicKey(key).export({ format: 'jwk' })
	return Buffer.concat([Buffer.of(4), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
}

function generateQuestionKey(): QuestionKey {
	const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
	const publicKey = publicKeyFromPrivate(privateKey).toString('base64url')
	return { publicKey, privateKey }
}

function generateToken(): string {
	let token = ''
	while (token.length < 12) {
		for (const byte of randomBytes(16)) {
			// 248 is the largest multiple of 62 below 256, avoiding modulo bias.
			if (byte < 248) token += alphabet[byte % alphabet.length]
			if (token.length === 12) return token
		}
	}
	return token
}

function save(data: ServerKeyStore): void {
	liveFiles.save(data)
}

function init(): void {
	if (state.initialized) return
	state.store = liveFiles.liveFile(config.path, {
		tokens: [{ token: generateToken(), purpose: 'local web token', createdAt: new Date().toISOString() }],
	}, { watch: false, mode: 0o600 })
	state.store.questionKey ??= generateQuestionKey()
	state.initialized = true
}

function current(): ServerKeyStore & { questionKey: QuestionKey } {
	init()
	return state.store as ServerKeyStore & { questionKey: QuestionKey }
}

function copyToken(token: WebToken): WebToken {
	return { ...token }
}

function list(): WebToken[] {
	return current().tokens.map(copyToken)
}

function mint(purpose = 'web token'): WebToken {
	const trimmed = purpose.trim()
	if (!trimmed || trimmed.length > 120) throw new Error('Token purpose must be 1–120 characters.')
	const token = { token: generateToken(), purpose: trimmed, createdAt: new Date().toISOString() }
	const data = current()
	data.tokens = [...data.tokens, token]
	save(data)
	return copyToken(token)
}

function ensureLocalToken(): WebToken {
	const token = current().tokens[0]
	return token ? copyToken(token) : mint('local web token')
}

// Constant-time comparison prevents discovery of a valid token byte by byte from response timing.
function equalsConstantTime(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8')
	const right = Buffer.from(b, 'utf8')
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

function authenticate(token: string, ip: string): WebToken | null {
	const data = current()
	const found = data.tokens.find((item) => equalsConstantTime(item.token, token))
	if (!found) return null
	found.lastUsedAt = new Date().toISOString()
	found.lastUsedIp = ip
	data.tokens = [...data.tokens]
	save(data)
	return copyToken(found)
}

function revoke(position: number): WebToken | null {
	if (!Number.isInteger(position) || position < 1) return null
	const data = current()
	const [token] = data.tokens.splice(position - 1, 1)
	if (!token) return null
	data.tokens = [...data.tokens]
	save(data)
	const copy = copyToken(token)
	for (const listener of revokeListeners) listener(copy)
	return copy
}

function onRevoke(listener: (token: WebToken) => void): () => void {
	revokeListeners.add(listener)
	return () => revokeListeners.delete(listener)
}

function publicKey(): string {
	return current().questionKey.publicKey
}

function additionalData(sessionId: string, questionId: string): Uint8Array<ArrayBuffer> {
	if (!sessionId || !questionId || sessionId.includes('\0') || questionId.includes('\0')) throw new Error()
	return new TextEncoder().encode(`hal-question\0${sessionId}\0${questionId}`)
}

async function decryptSecret(packet: string, sessionId: string, questionId: string): Promise<string> {
	const privateKey = current().questionKey.privateKey
	try {
		if (typeof packet !== 'string' || packet.length > MAX_PACKET_LENGTH || !/^[A-Za-z0-9_-]+$/.test(packet)) throw new Error()
		const bytes = Buffer.from(packet, 'base64url')
		if (bytes.toString('base64url') !== packet || bytes.byteLength < 65 + 12 + 16 || bytes.byteLength > MAX_PACKET_BYTES) throw new Error()
		const ephemeralBytes = new Uint8Array(bytes.subarray(0, 65))
		if (ephemeralBytes[0] !== 4) throw new Error()
		const iv = new Uint8Array(bytes.subarray(65, 77))
		const ciphertext = new Uint8Array(bytes.subarray(77))
		const privateBytes = new Uint8Array(Buffer.from(privateKey, 'base64url'))
		const privateCryptoKey = await crypto.subtle.importKey('pkcs8', privateBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
		const ephemeralKey = await crypto.subtle.importKey('raw', ephemeralBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
		const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeralKey }, privateCryptoKey, 256)
		const aesKey = await crypto.subtle.importKey('raw', sharedSecret, 'AES-GCM', false, ['decrypt'])
		const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(sessionId, questionId), tagLength: 128 }, aesKey, ciphertext)
		return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
	} catch {
		throw new Error('Invalid encrypted question answer.')
	}
}

export const serverKeys = { config, state, init, list, mint, ensureLocalToken, authenticate, revoke, onRevoke, publicKey, decryptSecret }
