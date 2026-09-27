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
	let res = await post(`${chatgptLogin.deviceUrl()}/usercode`, { client_id: OPENAI_CLIENT_ID })
	if (res.status === 404) throw new Error('ChatGPT device-code login is unavailable: enable device-code login in your ChatGPT security or workspace settings')
	if (!res.ok) throw new Error(`ChatGPT device-code request failed: HTTP ${res.status}`)
	let data: any = await res.json().catch(() => null)
	if (typeof data?.device_auth_id !== 'string' || typeof data?.user_code !== 'string') throw new Error('ChatGPT device-code response is missing its code')
	let interval = Number(data.interval)
	return { id: data.device_auth_id, userCode: data.user_code, intervalMs: Math.max(0, Number.isFinite(interval) ? interval * 1000 : 5000), url: chatgptLogin.verifyUrl() }
}

// Polls until the user has entered the code; 403 and 404 mean not yet.
async function wait(device: Device): Promise<{ code: string; verifier: string }> {
	let deadline = clock.now() + chatgptLogin.timeoutMs()
	while (true) {
		let res = await post(`${chatgptLogin.deviceUrl()}/token`, { device_auth_id: device.id, user_code: device.userCode })
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
async function exchange(grant: { code: string; verifier: string }): Promise<string | undefined> {
	let res = await fetch(auth.tokenUrl('openai'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'authorization_code', client_id: OPENAI_CLIENT_ID, code: grant.code, code_verifier: grant.verifier, redirect_uri: CALLBACK }),
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

// The whole flow: `show` gets the URL and code to tell the user.
async function run(show: (text: string) => void): Promise<string | undefined> {
	try {
		let device = await chatgptLogin.start()
		show(`Open this URL to log in to ChatGPT:\n\n${device.url}\n\nand enter this one-time code (expires in 15 minutes):\n\n${device.userCode}\n\nOnly continue if you started this login in Hal.`)
		return await chatgptLogin.exchange(await chatgptLogin.wait(device))
	} finally {
		// A session blocked on login tries again (auth.changed).
		auth.state.logins++
	}
}

export const chatgptLogin = {
	deviceUrl: () => 'https://auth.openai.com/api/accounts/deviceauth',
	verifyUrl: () => 'https://auth.openai.com/codex/device',
	timeoutMs: () => 15 * 60_000,
	start,
	wait,
	exchange,
	run,
}
