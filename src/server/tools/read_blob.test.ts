import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { readBlobTool } from './read_blob.ts'
import { sessions } from '../sessions.ts'
import { ason } from '../../utils/ason.ts'

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

test('read_blob returns stored image attachments as native tool content', async () => {
	writeBlob('04-whl', '0gdec4-img', { media_type: 'image/png', data: 'aGVsbG8=' })

	const output = await readBlobTool.execute({ id: '0gdec4-img' }, { sessionId: '04-whl', cwd: process.cwd() })
	expect(output).toEqual([
		{ type: 'text', text: 'Read image blob "0gdec4-img" [image/png]' },
		{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
	])
})

test('read_blob reads namespaced ids from another session', async () => {
	writeBlob('04-fyx', '0gdec4-bol', { source: 'other-session' })

	const text = await readBlobTool.execute({ id: '04-fyx/0gdec4-bol' }, { sessionId: '04-whl', cwd: process.cwd() })
	if (typeof text !== 'string') throw new Error('expected text output')
	const data = JSON.parse(text)
	expect(data).toEqual({ source: 'other-session' })
})
