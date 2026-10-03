// /login chatgpt: the ChatGPT subscription device-code flow (the old
// Hal's and the Codex CLI's), which works on remote and headless hosts:
// Hal shows a URL and a one-time code, the user enters the code in any
// browser, and Hal polls until OpenAI hands over an authorization code
// (up to 15 minutes), exchanges it for tokens and saves them as an
// openai account in this home's credentials file (login.save).
//
// Polling is awaited in the command's own async run, never blocking the
// host; it lives in memory, so a restart drops it (run /login again).
// Errors never quote a code or a token: only HTTP statuses and
// sanitized error codes.
//
// On this machine (no webUrl, no SSH) it uses the Codex CLI's browser
// flow instead: no device-code setting needed. OpenAI only accepts
// http://localhost:1455/auth/callback as its redirect, so the browser
// must run where the host does; a busy port falls back to the device
// code.

import { settings } from '../common/settings.ts'
import { auth, jwtClaims, OPENAI_CLIENT_ID } from './auth.ts'
import { clock } from './clock.ts'
import { login } from './login.ts'

export type Device = { id: string; userCode: string; intervalMs: number; url: string }

const CALLBACK = 'https://auth.openai.com/deviceauth/callback'

function code(body: any): string {
	return typeof body?.error === 'string' && /^[\w.-]{1,64}$/.test(body.error) ? ` ${body.error}` : ''
}

async function post(url: string, body: unknown): Promise<Response> {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(auth.refreshTimeoutMs()),
	})
}

// Asks for a user code to show.
async function start(): Promise<Device> {
	let res = await post(`${chatgptLogin.deviceUrl}/usercode`, { client_id: OPENAI_CLIENT_ID })
	if (res.status === 404) throw new Error('ChatGPT device-code login is unavailable: turn on Enable device code sign-in at https://chatgpt.com/#settings/Security (or ask your workspace admin)')
	if (!res.ok) throw new Error(`ChatGPT device-code request failed: HTTP ${res.status}`)
	let data: any = await res.json().catch(() => null)
	if (typeof data?.device_auth_id !== 'string' || typeof data?.user_code !== 'string') throw new Error('ChatGPT device-code response is missing its code')
	let interval = Number(data.interval)
	return { id: data.device_auth_id, userCode: data.user_code, intervalMs: Math.max(0, Number.isFinite(interval) ? interval * 1000 : 5000), url: chatgptLogin.verifyUrl }
}

// Polls until the user has entered the code; 403 and 404 mean not yet.
async function wait(device: Device): Promise<{ code: string; verifier: string }> {
	let deadline = clock.now() + chatgptLogin.timeoutMs
	while (true) {
		let res = await post(`${chatgptLogin.deviceUrl}/token`, { device_auth_id: device.id, user_code: device.userCode })
		if (res.ok) {
			let data: any = await res.json().catch(() => null)
			if (typeof data?.authorization_code !== 'string' || typeof data?.code_verifier !== 'string') throw new Error('ChatGPT device-code response is missing its authorization code')
			return { code: data.authorization_code, verifier: data.code_verifier }
		}
		if (res.status !== 403 && res.status !== 404) throw new Error(`ChatGPT login failed: HTTP ${res.status}`)
		if (clock.now() >= deadline) throw new Error('ChatGPT login timed out after 15 minutes; run /login chatgpt again')
		await clock.sleep(device.intervalMs)
	}
}

// Exchanges the authorization code for tokens and saves them. Returns
// the account's email, if the token names one.
async function exchange(grant: { code: string; verifier: string }, redirect = CALLBACK): Promise<string | undefined> {
	let res = await fetch(auth.tokenUrl('openai'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'authorization_code', client_id: OPENAI_CLIENT_ID, code: grant.code, code_verifier: grant.verifier, redirect_uri: redirect }),
		signal: AbortSignal.timeout(auth.refreshTimeoutMs()),
	})
	let body: any = await res.json().catch(() => null)
	if (!res.ok) throw new Error(`ChatGPT login failed: HTTP ${res.status}${code(body)}`)
	if (typeof body?.access_token !== 'string' || typeof body?.refresh_token !== 'string') throw new Error('ChatGPT login failed: no tokens in the response')
	let claims = jwtClaims(body.access_token)
	let accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id
	let email = claims?.['https://api.openai.com/profile']?.email
	let expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
	login.save(
		{
			accessToken: body.access_token,
			refreshToken: body.refresh_token,
			expires: Date.now() + expiresIn * 1000,
			...(typeof accountId === 'string' && accountId && { accountId }),
			...(typeof email === 'string' && email && { email }),
		},
		'openai',
	)
	return typeof email === 'string' && email ? email : undefined
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// The browser flow's redirect listener and the URL to open; undefined
// when the port is taken (another login, or a Codex CLI).
async function browser(): Promise<{ url: string; grant: Promise<{ code: string; verifier: string }>; stop(): void } | undefined> {
	let verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
	let state = base64url(crypto.getRandomValues(new Uint8Array(32)))
	let challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
	let done!: (code: string) => void, fail!: (e: Error) => void
	let got = new Promise<string>((a, b) => ((done = a), (fail = b)))
	let server: ReturnType<typeof Bun.serve>
	try {
		server = Bun.serve({
			hostname: '127.0.0.1',
			port: chatgptLogin.callbackPort,
			fetch(req) {
				let u = new URL(req.url)
				if (u.pathname !== '/auth/callback') return new Response('Not found', { status: 404 })
				// The state ties the answer to this login; anything else is refused.
				if (u.searchParams.get('state') !== state) return new Response('This login link is stale; run /login chatgpt again.', { status: 400 })
				let code = u.searchParams.get('code')
				if (!code) {
					let error = u.searchParams.get('error') ?? ''
					fail(new Error(`ChatGPT login failed: ${/^[\w.-]{1,64}$/.test(error) ? error : 'no code in the redirect'}`))
					return new Response('ChatGPT login failed; see Hal.', { status: 400 })
				}
				done(code)
				return new Response('Signed in to ChatGPT. You can close this tab and go back to Hal.')
			},
		})
	} catch {
		return undefined
	}
	let u = new URL(chatgptLogin.authorizeUrl)
	let params = { response_type: 'code', client_id: OPENAI_CLIENT_ID, redirect_uri: chatgptLogin.redirect(), scope: 'openid profile email offline_access', code_challenge: challenge, code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state, originator: 'codex_cli_rs' }
	for (let [k, v] of Object.entries(params)) u.searchParams.set(k, v)
	let timer = setTimeout(() => fail(new Error('ChatGPT login timed out after 15 minutes; run /login chatgpt again')), chatgptLogin.timeoutMs)
	let stop = () => { clearTimeout(timer); server.stop(true) }
	return { url: u.toString(), grant: got.then((code) => ({ code, verifier })), stop }
}

// The browser can reach this host's localhost: no public address is
// configured and the host was not started over SSH.
const local = () => !settings.value('webUrl') && !process.env.SSH_CONNECTION && !process.env.SSH_TTY

// The whole flow: `show` gets the URL (and code) to tell the user.
async function run(show: (text: string) => void): Promise<string | undefined> {
	try {
		let flow = chatgptLogin.local() ? await chatgptLogin.browser() : undefined
		if (flow) {
			try {
				show(`Open this URL in a browser on this computer to log in to ChatGPT (it waits up to 15 minutes):\n\n${flow.url}`)
				return await chatgptLogin.exchange(await flow.grant, chatgptLogin.redirect())
			} finally {
				flow.stop()
			}
		}
		show('Before ChatGPT login, turn on Enable device code sign-in at https://chatgpt.com/#settings/Security')
		let device = await chatgptLogin.start()
		show(`Open this URL to log in to ChatGPT:\n\n${device.url}\n\nand enter this one-time code (expires in 15 minutes):\n\n${device.userCode}\n\nOnly continue if you started this login in Hal.`)
		return await chatgptLogin.exchange(await chatgptLogin.wait(device))
	} finally {
		// A session blocked on login tries again (auth.changed).
		auth.state.logins++
	}
}

export const chatgptLogin = {
	deviceUrl: 'https://auth.openai.com/api/accounts/deviceauth',
	verifyUrl: 'https://auth.openai.com/codex/device',
	timeoutMs: 15 * 60_000,
	authorizeUrl: 'https://auth.openai.com/oauth/authorize',
	callbackPort: 1455,
	redirect: () => `http://localhost:${chatgptLogin.callbackPort}/auth/callback`,
	local,
	browser,
	start,
	wait,
	exchange,
	run,
}
