#!/usr/bin/env bun
// OAuth login for OpenAI (GPT / Codex).
// Opens browser → localhost callback server catches the code → exchanges for tokens → saves to auth.ason.
// Uses PKCE (S256) for security.

import { randomBytes, createHash } from 'crypto'
import { createServer } from 'http'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { ason } from '../src/utils/ason.ts'

const AUTH_PATH = import.meta.dir + '/../auth.ason'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPE = process.env.OPENAI_OAUTH_SCOPE ?? 'openid profile email offline_access'
const ORIGINATOR = process.env.OPENAI_ORIGINATOR ?? 'pi'

// Load or create auth store
let auth: Record<string, any> = {}
if (existsSync(AUTH_PATH)) {
	try { auth = ason.parse(readFileSync(AUTH_PATH, 'utf-8')) as any } catch {}
}

function base64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const verifier = base64url(randomBytes(32))
const challenge = base64url(createHash('sha256').update(verifier).digest())
const state = randomBytes(16).toString('hex')

const url = new URL(AUTHORIZE_URL)
url.searchParams.set('response_type', 'code')
url.searchParams.set('client_id', CLIENT_ID)
url.searchParams.set('redirect_uri', REDIRECT_URI)
url.searchParams.set('scope', SCOPE)
url.searchParams.set('code_challenge', challenge)
url.searchParams.set('code_challenge_method', 'S256')
url.searchParams.set('state', state)
url.searchParams.set('id_token_add_organizations', 'true')
url.searchParams.set('codex_cli_simplified_flow', 'true')
url.searchParams.set('originator', ORIGINATOR)

console.log('\nOpenAI Login\n')
console.log('Open this URL in your browser:\n')
console.log(url.toString())
console.log('\nWaiting for callback on http://localhost:1455 ...\n')

// Try to open browser automatically
try {
	const proc = Bun.spawn(['open', url.toString()], { stdout: 'ignore', stderr: 'ignore' })
	await proc.exited
} catch {}

// Start local callback server to catch the redirect
const code = await new Promise<string>((resolve, reject) => {
	const server = createServer((req, res) => {
		try {
			const reqUrl = new URL(req.url || '', 'http://localhost')
			if (reqUrl.pathname !== '/auth/callback') {
				res.statusCode = 404
				res.end('Not found')
				return
			}
			if (reqUrl.searchParams.get('state') !== state) {
				res.statusCode = 400
				res.end('State mismatch')
				return
			}
			const oauthError = reqUrl.searchParams.get('error')
			if (oauthError) {
				const desc = reqUrl.searchParams.get('error_description') || ''
				res.statusCode = 400
				res.end(`OAuth error: ${oauthError}`)
				server.close()
				reject(new Error(`OAuth error: ${oauthError}${desc ? ` (${desc})` : ''}`))
				return
			}
			const code = reqUrl.searchParams.get('code')
			if (!code) {
				res.statusCode = 400
				res.end('Missing authorization code')
				return
			}
			res.statusCode = 200
			res.setHeader('Content-Type', 'text/html')
			res.end('<html><body><p>Authentication successful! You can close this tab.</p></body></html>')
			server.close()
			resolve(code)
		} catch (e: any) {
			res.statusCode = 500
			res.end('Internal error')
			reject(e)
		}
	})
	server.listen(1455, '127.0.0.1', () => console.log('Listening on http://127.0.0.1:1455'))
	server.on('error', (err: any) => {
		if (err.code === 'EADDRINUSE') reject(new Error('Port 1455 already in use'))
		else reject(err)
	})
	// 10 minute timeout
	setTimeout(() => { server.close(); reject(new Error('Timed out (10min)')) }, 600_000)
})

console.log('Got authorization code, exchanging for tokens...')

const tokenRes = await fetch(TOKEN_URL, {
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: CLIENT_ID,
		code,
		code_verifier: verifier,
		redirect_uri: REDIRECT_URI,
	}),
})

if (!tokenRes.ok) {
	console.error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`)
	process.exit(1)
}

const { access_token, refresh_token, expires_in } = (await tokenRes.json()) as any
if (!access_token || !refresh_token) {
	console.error('Token response missing required fields')
	process.exit(1)
}

// Extract account ID from JWT for Codex API routing
function decodeJwt(token: string): any {
	try {
		const parts = token.split('.')
		if (parts.length !== 3) return null
		return JSON.parse(atob(parts[1]))
	} catch { return null }
}

const jwt = decodeJwt(access_token)
const accountId = jwt?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null

auth.openai = {
	...auth.openai,
	accessToken: access_token,
	refreshToken: refresh_token,
	expires: Date.now() + (expires_in ?? 3600) * 1000,
	...(accountId ? { accountId } : {}),
}
writeFileSync(AUTH_PATH, ason.stringify(auth) + '\n')

console.log(`\nSaved to auth.ason (expires in ${Math.round((expires_in ?? 3600) / 60)}min)`)
console.log('Run `./run` to start Hal with OpenAI.\n')
