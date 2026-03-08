// Auth — reads HAL_DIR/auth.ason (shared with old code), handles OAuth refresh.
// Uses liveFile so external edits (e.g. scripts/login-*.ts) are picked up.

import { liveFile } from '../live-file.ts'
import { HAL_DIR } from '../state.ts'

const AUTH_PATH = `${HAL_DIR}/auth.ason`
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

let _auth: Record<string, any> | null = null

function auth(): Record<string, any> {
	if (!_auth) _auth = liveFile(AUTH_PATH, { defaults: {} })
	return _auth
}

export function getAuth(provider: string): { accessToken: string; refreshToken?: string; expires?: number } {
	return auth()[provider] ?? {}
}

export async function refreshAnthropicAuth(): Promise<void> {
	const a = getAuth('anthropic')
	if (!a.refreshToken || Date.now() < (a.expires ?? 0)) return

	const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: CLIENT_ID }),
	})
	const data = (await res.json()) as any
	if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`)

	// Top-level property set triggers liveFile flush
	auth().anthropic = { ...auth().anthropic, accessToken: data.access_token, refreshToken: data.refresh_token, expires: Date.now() + data.expires_in * 1000 }
}
