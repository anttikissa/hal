// Question-secret encryption prevents accidental disclosure through IPC, history,
// logs/debug inspection, and later LLM-provider context. It is not a sandbox
// against same-user arbitrary code or theft of the whole state directory. Remote
// use still requires HTTPS, which authenticates the server public key.

import { generateKeyPairSync, privateDecrypt, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync } from 'fs'
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
	questionKey: QuestionKey
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const config = {
	path: `${STATE_DIR}/server-keys.ason`,
}

const state: { initialized: boolean; store: ServerKeyStore | null } = {
	initialized: false,
	store: null,
}

const revokeListeners = new Set<(token: WebToken) => void>()

// RSA-OAEP is the shortest old-Safari-compatible option but always stores 256
// ciphertext bytes. ECDH plus AES-GCM would be smaller if secret questions become common.
function generateQuestionKey(): QuestionKey {
	const pair = generateKeyPairSync('rsa', { modulusLength: 2_048 })
	return {
		publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
		privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
	}
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
	const exists = existsSync(config.path)
	state.store = liveFiles.liveFile(config.path, {} as ServerKeyStore, { watch: false, mode: 0o600 })
	if (!exists) {
		state.store.tokens = [{ token: generateToken(), purpose: 'local web token', createdAt: new Date().toISOString() }]
		state.store.questionKey = generateQuestionKey()
		save(state.store)
	}
	state.initialized = true
}

function current(): ServerKeyStore {
	init()
	return state.store!
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

async function decryptSecret(ciphertext: string): Promise<string> {
	try {
		if (typeof ciphertext !== 'string' || ciphertext.length > 400) throw new Error()
		const encrypted = Buffer.from(ciphertext, 'base64')
		if (encrypted.byteLength !== 256) throw new Error()
		const plaintext = privateDecrypt({
			key: current().questionKey.privateKey,
			oaepHash: 'sha256',
		}, encrypted)
		return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
	} catch {
		throw new Error('Invalid encrypted question answer.')
	}
}

export const serverKeys = { config, state, init, list, mint, ensureLocalToken, authenticate, revoke, onRevoke, publicKey, decryptSecret }
