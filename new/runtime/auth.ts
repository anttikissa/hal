// Auth — reads HAL_DIR/auth.ason (shared with old code), handles OAuth refresh.

import { readFileSync, writeFileSync } from 'fs'
import { parse, stringify } from '../utils/ason.ts'
import { HAL_DIR } from '../state.ts'

const AUTH_PATH = `${HAL_DIR}/auth.ason`
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

let _auth: any = null

function load(): any {
	if (!_auth) {
		try { _auth = parse(readFileSync(AUTH_PATH, 'utf-8')) }
		catch { _auth = {} }
	}
	return _auth
}

export function getAuth(provider: string): { accessToken: string; refreshToken?: string; expires?: number } {
	return load()[provider] ?? {}
}

export async function refreshAnthropicAuth(): Promise<void> {
	const auth = getAuth('anthropic')
	if (!auth.refreshToken || Date.now() < (auth.expires ?? 0)) return

	const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: CLIENT_ID }),
	})
	const data = (await res.json()) as any
	if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`)

	const full = load()
	full.anthropic = { ...full.anthropic, accessToken: data.access_token, refreshToken: data.refresh_token, expires: Date.now() + data.expires_in * 1000 }
	_auth = full
	writeFileSync(AUTH_PATH, stringify(full) + '\n')
}
