import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { questionCrypto } from '../common/question-crypto.ts'
import { ason } from '../utils/ason.ts'
import { serverKeys } from './server-keys.ts'

const originalPath = serverKeys.config.path
const originalLegacyPath = serverKeys.config.legacyPath
const originalInitialized = serverKeys.state.initialized
const dirs: string[] = []

function useKeyFiles(): { path: string; legacyPath: string } {
	const dir = mkdtempSync(join(tmpdir(), 'hal-server-keys-'))
	dirs.push(dir)
	serverKeys.config.path = join(dir, 'server-keys.ason')
	serverKeys.config.legacyPath = join(dir, 'auth-tokens.ason')
	serverKeys.state.initialized = false
	return { path: serverKeys.config.path, legacyPath: serverKeys.config.legacyPath }
}

afterEach(() => {
	serverKeys.config.path = originalPath
	serverKeys.config.legacyPath = originalLegacyPath
	serverKeys.state.initialized = originalInitialized
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

test('provisions one local web token and a persistent P-256 key pair', () => {
	const { path } = useKeyFiles()
	serverKeys.init()
	const publicKey = serverKeys.publicKey()
	const original = readFileSync(path, 'utf8')
	const [token] = serverKeys.list()

	expect(token?.purpose).toBe('local web token')
	expect(token?.token).toMatch(/^[A-Za-z0-9]{12}$/)
	expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65)
	expect(statSync(path).mode & 0o777).toBe(0o600)

	chmodSync(path, 0o644)
	serverKeys.state.initialized = false
	serverKeys.init()
	expect(serverKeys.publicKey()).toBe(publicKey)
	expect(readFileSync(path, 'utf8')).toBe(original)
	expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('migrates the old token file once without changing bearer tokens', () => {
	const { path, legacyPath } = useKeyFiles()
	const tokens = [{ token: 'AbCdEf123456', purpose: 'existing browser', createdAt: '2026-08-25T00:00:00.000Z' }]
	writeFileSync(legacyPath, ason.stringify({ tokens }) + '\n')

	serverKeys.init()

	expect(serverKeys.list()).toEqual(tokens)
	expect(existsSync(path)).toBe(true)
	expect(existsSync(legacyPath)).toBe(false)
	expect(statSync(path).mode & 0o777).toBe(0o600)
	expect((ason.parse(readFileSync(path, 'utf8')) as any).questionKey.privateKey).toBeString()
})

test('malformed ASON, old tokens, or current keys fail loudly without overwrite', () => {
	let files = useKeyFiles()
	writeFileSync(files.legacyPath, "{ tokens: ['secret-token'] }\n")
	const malformedLegacy = readFileSync(files.legacyPath, 'utf8')
	expect(() => serverKeys.init()).toThrow(/Invalid server key state/)
	expect(existsSync(files.path)).toBe(false)
	expect(readFileSync(files.legacyPath, 'utf8')).toBe(malformedLegacy)

	files = useKeyFiles()
	writeFileSync(files.path, "{ tokens: [], questionKey: { publicKey: 'bad', privateKey: 'also-bad' } }\n")
	const malformedCurrent = readFileSync(files.path, 'utf8')
	expect(() => serverKeys.init()).toThrow(/Invalid server key state/)
	expect(readFileSync(files.path, 'utf8')).toBe(malformedCurrent)

	files = useKeyFiles()
	writeFileSync(files.path, '{ definitely not valid ASON')
	const malformedAson = readFileSync(files.path, 'utf8')
	expect(() => serverKeys.init()).toThrow(/Invalid server key state/)
	expect(readFileSync(files.path, 'utf8')).toBe(malformedAson)
})

test('decrypts scoped question secrets and rejects tampering or wrong AAD', async () => {
	const { path } = useKeyFiles()
	const plaintext = 'påssword 🔑'
	const ciphertext = await questionCrypto.encryptSecret(serverKeys.publicKey(), 'session-1', 'question-1', plaintext)

	expect(await serverKeys.decryptSecret(ciphertext, 'session-1', 'question-1')).toBe(plaintext)
	expect(readFileSync(path, 'utf8')).not.toContain(plaintext)
	await expect(serverKeys.decryptSecret(ciphertext, 'session-2', 'question-1')).rejects.toThrow(/Invalid encrypted question answer/)
	const packet = Buffer.from(ciphertext, 'base64url')
	packet[packet.length - 1] = packet[packet.length - 1]! ^ 1
	await expect(serverKeys.decryptSecret(packet.toString('base64url'), 'session-1', 'question-1')).rejects.toThrow(/Invalid encrypted question answer/)
	await expect(serverKeys.decryptSecret('A'.repeat(5_587), 'session-1', 'question-1')).rejects.toThrow(/Invalid encrypted question answer/)
	await expect(serverKeys.decryptSecret(1_000_000_000 as any, 'session-1', 'question-1')).rejects.toThrow(/Invalid encrypted question answer/)
})

test('web token operations keep their existing behavior in the combined store', () => {
	const { path } = useKeyFiles()
	serverKeys.init()
	const token = serverKeys.mint('laptop browser')
	expect(serverKeys.authenticate(token.token, '127.0.0.1')?.lastUsedIp).toBe('127.0.0.1')
	expect((ason.parse(readFileSync(path, 'utf8')) as { tokens: Array<{ lastUsedIp?: string }> }).tokens[1]?.lastUsedIp).toBe('127.0.0.1')
	expect(serverKeys.revoke(2)?.purpose).toBe('laptop browser')
	expect(serverKeys.authenticate('', '127.0.0.1')).toBeNull()
	serverKeys.revoke(1)
	expect(serverKeys.list()).toEqual([])
	expect(serverKeys.ensureLocalToken().purpose).toBe('local web token')
})
