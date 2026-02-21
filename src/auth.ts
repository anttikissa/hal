import { readFileSync, writeFileSync } from 'fs'
import { stringify, parse } from './utils/ason.ts'
import { HAL_DIR } from './state.ts'

const AUTH_PATH = `${HAL_DIR}/auth.ason`

export interface ProviderAuth {
	accessToken: string
	refreshToken: string
	expires: number
	accountId?: string
}

export interface AuthFile {
	anthropic?: ProviderAuth
	openai?: ProviderAuth
}

let _auth: AuthFile | null = null

export function loadAuth(): AuthFile {
	if (_auth) return _auth
	try {
		const raw = readFileSync(AUTH_PATH, 'utf-8')
		_auth = parse(raw) as AuthFile
	} catch {
		_auth = {}
	}
	return _auth
}

export function saveAuth(auth: AuthFile): void {
	_auth = auth
	writeFileSync(AUTH_PATH, stringify(auth) + '\n')
}

export function getProviderAuth(provider: string): ProviderAuth | undefined {
	const auth = loadAuth()
	if (provider === 'anthropic') return auth.anthropic
	if (provider === 'openai') return auth.openai
	return undefined
}

export function updateProviderAuth(provider: string, updates: Partial<ProviderAuth>): void {
	const auth = loadAuth()
	const key = provider as keyof AuthFile
	const current = auth[key] ?? { accessToken: '', refreshToken: '', expires: 0 }
	auth[key] = { ...current, ...updates }
	saveAuth(auth)
}
