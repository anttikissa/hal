#!/usr/bin/env bun
// OAuth login for Anthropic (Claude).
// Opens browser → user authorizes → exchanges code for tokens → saves to auth.ason.
// Uses PKCE (S256) for security.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { ason } from '../src/utils/ason.ts'

const AUTH_PATH = import.meta.dir + '/../auth.ason'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'

// Load or create auth store
let auth: Record<string, any> = {}
if (existsSync(AUTH_PATH)) {
	try { auth = ason.parse(readFileSync(AUTH_PATH, 'utf-8')) as any } catch {}
}

// PKCE: generate verifier + S256 challenge
async function generatePKCE() {
	const bytes = crypto.getRandomValues(new Uint8Array(43))
	const verifier = Array.from(bytes)
		.map(b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62])
		.join('')
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	return { verifier, challenge }
}

const pkce = await generatePKCE()

const url = new URL('https://claude.ai/oauth/authorize')
url.searchParams.set('code', 'true')
url.searchParams.set('client_id', CLIENT_ID)
url.searchParams.set('response_type', 'code')
url.searchParams.set('redirect_uri', REDIRECT_URI)
url.searchParams.set('scope', 'org:create_api_key user:profile user:inference')
url.searchParams.set('code_challenge', pkce.challenge)
url.searchParams.set('code_challenge_method', 'S256')
url.searchParams.set('state', pkce.verifier)

console.log('\nAnthropic (Claude) Login\n')
console.log('Open this URL:\n')
console.log(url.toString())
console.log()

// Try to open browser automatically
try {
	const proc = Bun.spawn(['open', url.toString()], { stdout: 'ignore', stderr: 'ignore' })
	await proc.exited
} catch {}

const code = prompt('Paste authorization code:')
if (!code?.trim()) {
	console.error('No code entered.')
	process.exit(1)
}

// Anthropic returns "code#state" — split on #
const [authCode, state] = code.trim().split('#')

const res = await fetch(TOKEN_URL, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({
		code: authCode,
		state,
		grant_type: 'authorization_code',
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		code_verifier: pkce.verifier,
	}),
})

if (!res.ok) {
	console.error('Auth failed:', await res.text())
	process.exit(1)
}

const { access_token, refresh_token, expires_in } = await res.json() as any

auth.anthropic = {
	...auth.anthropic,
	accessToken: access_token,
	refreshToken: refresh_token,
	expires: Date.now() + expires_in * 1000,
}
writeFileSync(AUTH_PATH, ason.stringify(auth) + '\n')

console.log(`\nSaved to auth.ason (expires in ${Math.round(expires_in / 60)}min)`)
console.log('Run `./run` to start Hal with Claude.\n')
