import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { readBlobTool } from './read_blob.ts'
import { sessions } from '../server/sessions.ts'
import { ason } from '../utils/ason.ts'

const TEST_DIR = '/tmp/hal-test-read-blob'
const origSessionDir = sessions.sessionDir

beforeEach(() => {
	sessions.sessionDir = (id: string) => `${TEST_DIR}/sessions/${id}`
})

afterEach(() => {
	sessions.sessionDir = origSessionDir
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
})

function writeBlob(sessionId: string, blobId: string, data: unknown): void {
	const dir = `${TEST_DIR}/sessions/${sessionId}/blobs`
	mkdirSync(dir, { recursive: true })
	writeFileSync(`${dir}/${blobId}.ason`, ason.stringify(data) + '\n')
}

test('read_blob reads bare ids from the current session', async () => {
	writeBlob('04-whl', '0gdec4-bol', { ok: true })

	const text = await readBlobTool.execute({ id: '0gdec4-bol' }, { sessionId: '04-whl', cwd: process.cwd() })
	const data = JSON.parse(text)
	expect(data).toEqual({ ok: true })
})

test('read_blob reads namespaced ids from another session', async () => {
	writeBlob('04-fyx', '0gdec4-bol', { source: 'other-session' })

	const text = await readBlobTool.execute({ id: '04-fyx/0gdec4-bol' }, { sessionId: '04-whl', cwd: process.cwd() })
	const data = JSON.parse(text)
	expect(data).toEqual({ source: 'other-session' })
})
