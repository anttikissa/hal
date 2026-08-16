import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { ason } from '../utils/ason.ts'
import { STATE_DIR } from './state.ts'

export type WebToken = {
	token: string
	purpose: string
	createdAt: string
	lastUsedAt?: string
	lastUsedIp?: string
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const state: {
	initialized: boolean
	path: string
	tokens: WebToken[]
	revokeListeners: Set<(token: WebToken) => void>
} = {
	initialized: false,
	path: `${STATE_DIR}/auth-tokens.ason`,
	tokens: [],
	revokeListeners: new Set(),
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

function parseTokens(data: unknown): WebToken[] {
	if (!data || typeof data !== 'object' || !Array.isArray((data as { tokens?: unknown }).tokens)) throw new Error(`Invalid web token state: ${state.path}`)
	const tokens: WebToken[] = []
	for (const entry of (data as { tokens: unknown[] }).tokens) {
		if (!entry || typeof entry !== 'object') throw new Error(`Invalid web token state: ${state.path}`)
		const token = entry as Record<string, unknown>
		if (typeof token.token !== 'string' || !/^[A-Za-z0-9]{12}$/.test(token.token) || typeof token.purpose !== 'string' || typeof token.createdAt !== 'string') throw new Error(`Invalid web token state: ${state.path}`)
		if (token.lastUsedAt !== undefined && typeof token.lastUsedAt !== 'string') throw new Error(`Invalid web token state: ${state.path}`)
		if (token.lastUsedIp !== undefined && typeof token.lastUsedIp !== 'string') throw new Error(`Invalid web token state: ${state.path}`)
		tokens.push({ token: token.token, purpose: token.purpose, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt as string | undefined, lastUsedIp: token.lastUsedIp as string | undefined })
	}
	return tokens
}

function save(): void {
	const tmp = `${state.path}.${process.pid}.tmp`
	mkdirSync(dirname(state.path), { recursive: true })
	writeFileSync(tmp, ason.stringify({ tokens: state.tokens }) + '\n', { mode: 0o600 })
	renameSync(tmp, state.path)
}

function init(): void {
	if (state.initialized) return
	if (existsSync(state.path)) state.tokens = parseTokens(ason.parse(readFileSync(state.path, 'utf8')))
	else {
		state.tokens = [{ token: generateToken(), purpose: 'local web token', createdAt: new Date().toISOString() }]
		save()
	}
	state.initialized = true
}

function list(): WebToken[] {
	init()
	return [...state.tokens]
}

function mint(purpose = 'web token'): WebToken {
	init()
	const trimmed = purpose.trim()
	if (!trimmed || trimmed.length > 120) throw new Error('Token purpose must be 1–120 characters.')
	const token = { token: generateToken(), purpose: trimmed, createdAt: new Date().toISOString() }
	state.tokens.push(token)
	save()
	return token
}


function ensureLocalToken(): WebToken {
	init()
	return state.tokens[0] ?? mint('local web token')
}
function authenticate(token: string, ip: string): WebToken | null {
	init()
	const found = state.tokens.find((item) => item.token === token)
	if (!found) return null
	found.lastUsedAt = new Date().toISOString()
	found.lastUsedIp = ip
	save()
	return found
}

function revoke(position: number): WebToken | null {
	init()
	if (!Number.isInteger(position) || position < 1) return null
	const [token] = state.tokens.splice(position - 1, 1)
	if (!token) return null
	save()
	for (const listener of state.revokeListeners) listener(token)
	return token
}

function onRevoke(listener: (token: WebToken) => void): () => void {
	state.revokeListeners.add(listener)
	return () => state.revokeListeners.delete(listener)
}

export const webTokens = { state, generateToken, init, list, mint, ensureLocalToken, authenticate, revoke, onRevoke }
