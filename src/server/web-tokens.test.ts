import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ason } from '../utils/ason.ts'
import { webTokens } from './web-tokens.ts'

const originalPath = webTokens.state.path
const originalInitialized = webTokens.state.initialized
const originalTokens = webTokens.state.tokens
const dirs: string[] = []

function useTokenFile(): string {
	const dir = mkdtempSync(join(tmpdir(), 'hal-web-tokens-'))
	dirs.push(dir)
	webTokens.state.path = join(dir, 'auth-tokens.ason')
	webTokens.state.initialized = false
	webTokens.state.tokens = []
	return webTokens.state.path
}

afterEach(() => {
	webTokens.state.path = originalPath
	webTokens.state.initialized = originalInitialized
	webTokens.state.tokens = originalTokens
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

test('provisions one local web token only when the state file is absent', () => {
	const path = useTokenFile()
	webTokens.init()
	const [token] = webTokens.list()
	expect(existsSync(path)).toBe(true)
	expect(token?.purpose).toBe('local web token')
	expect(token?.token).toMatch(/^[A-Za-z0-9]{12}$/)
})

test('does not recreate a token after an existing empty state file is revoked', () => {
	const path = useTokenFile()
	writeFileSync(path, ason.stringify({ tokens: [] }) + '\n')
	webTokens.init()
	expect(webTokens.list()).toEqual([])
})

test('records use and revokes tokens by their displayed one-based position', () => {
	const path = useTokenFile()
	webTokens.init()
	const token = webTokens.mint('laptop browser')
	expect(webTokens.authenticate(token.token, '127.0.0.1')?.lastUsedIp).toBe('127.0.0.1')
	expect((ason.parse(readFileSync(path, 'utf8')) as { tokens: Array<{ lastUsedIp?: string }> }).tokens[1]?.lastUsedIp).toBe('127.0.0.1')
	expect(webTokens.revoke(2)?.purpose).toBe('laptop browser')
	expect(webTokens.list()).toHaveLength(1)
})

test('rejects wrong tokens of any length without matching', () => {
	useTokenFile()
	webTokens.init()
	const [token] = webTokens.list()
	expect(webTokens.authenticate(token!.token, '127.0.0.1')).not.toBeNull()
	expect(webTokens.authenticate('', '127.0.0.1')).toBeNull()
	expect(webTokens.authenticate(token!.token.slice(0, 11), '127.0.0.1')).toBeNull()
	expect(webTokens.authenticate(token!.token + 'x', '127.0.0.1')).toBeNull()
})

test('creates a fresh local token when an authenticated URL is requested after revocation', () => {
	useTokenFile()
	webTokens.init()
	webTokens.revoke(1)
	expect(webTokens.list()).toEqual([])
	expect(webTokens.ensureLocalToken().purpose).toBe('local web token')
})
