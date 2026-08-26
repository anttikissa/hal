import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { questionCrypto } from '../common/question-crypto.ts'
import { ason } from '../utils/ason.ts'
import { serverKeys } from './server-keys.ts'

const originalPath = serverKeys.config.path
const originalInitialized = serverKeys.state.initialized
const originalStore = serverKeys.state.store
const dirs: string[] = []

function useKeyFile(): string {
	const dir = mkdtempSync(join(tmpdir(), 'hal-server-keys-'))
	dirs.push(dir)
	serverKeys.config.path = join(dir, 'server-keys.ason')
	serverKeys.state.initialized = false
	serverKeys.state.store = null
	return serverKeys.config.path
}

afterEach(() => {
	serverKeys.config.path = originalPath
	serverKeys.state.initialized = originalInitialized
	serverKeys.state.store = originalStore
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

test('provisions one local web token and persists one RSA key pair through the live file', async () => {
	const path = useKeyFile()
	serverKeys.init()
	await Promise.resolve()
	const publicKey = serverKeys.publicKey()
	const original = readFileSync(path, 'utf8')
	const [token] = serverKeys.list()

	expect(token?.purpose).toBe('local web token')
	expect(token?.token).toMatch(/^[A-Za-z0-9]{12}$/)
	expect(Buffer.from(publicKey, 'base64')).not.toHaveLength(0)
	expect(statSync(path).mode & 0o777).toBe(0o600)

	serverKeys.state.initialized = false
	serverKeys.state.store = null
	serverKeys.init()
	expect(serverKeys.publicKey()).toBe(publicKey)
	expect(readFileSync(path, 'utf8')).toBe(original)
})

test('decrypts RSA-OAEP question secrets and rejects invalid ciphertext', async () => {
	const path = useKeyFile()
	const plaintext = 'påssword 🔑'
	const ciphertext = await questionCrypto.encryptSecret(serverKeys.publicKey(), plaintext)

	expect(Buffer.from(ciphertext, 'base64')).toHaveLength(256)
	expect(await serverKeys.decryptSecret(ciphertext)).toBe(plaintext)
	expect(readFileSync(path, 'utf8')).not.toContain(plaintext)
	const packet = Buffer.from(ciphertext, 'base64')
	packet[packet.length - 1] = packet[packet.length - 1]! ^ 1
	await expect(serverKeys.decryptSecret(packet.toString('base64'))).rejects.toThrow(/Invalid encrypted question answer/)
	await expect(serverKeys.decryptSecret('A'.repeat(401))).rejects.toThrow(/Invalid encrypted question answer/)
	await expect(serverKeys.decryptSecret(1_000_000_000 as any)).rejects.toThrow(/Invalid encrypted question answer/)
})

test('web token operations keep their existing behavior in the combined store', () => {
	const path = useKeyFile()
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
