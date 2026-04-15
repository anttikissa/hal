import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { blob } from './blob.ts'
import { sessions } from '../server/sessions.ts'
import { compactThinkingBlobs } from './compact-thinking-blobs.ts'

const createdSessions: string[] = []

afterEach(() => {
	for (const sessionId of createdSessions.splice(0)) {
		rmSync(sessions.sessionDir(sessionId), { recursive: true, force: true })
	}
})

test('compactSessions strips duplicated reasoning summary payloads from thinking blobs', async () => {
	const sessionId = `test-compact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	createdSessions.push(sessionId)
	await sessions.createSession(sessionId, { id: sessionId, createdAt: new Date().toISOString(), workingDir: process.cwd() })

	await blob.writeBlob(sessionId, '000001-dup', {
		thinking: 'duplicate text',
		signature: JSON.stringify({
			type: 'reasoning',
			id: 'rs_123',
			encrypted_content: 'secret',
			summary: [{ type: 'summary_text', text: 'duplicate text' }],
		}),
	})
	await blob.writeBlob(sessionId, '000002-keep', {
		thinking: 'plain text',
		signature: 'sig-123',
	})

	expect(await compactThinkingBlobs.compactSessions([sessionId])).toEqual({
		sessions: 1,
		blobs: 2,
		rewritten: 1,
	})

	expect(blob.readBlob(sessionId, '000001-dup')).toEqual({
		thinking: 'duplicate text',
		signature: JSON.stringify({
			type: 'reasoning',
			id: 'rs_123',
			encrypted_content: 'secret',
		}),
	})
	expect(blob.readBlob(sessionId, '000002-keep')).toEqual({
		thinking: 'plain text',
		signature: 'sig-123',
	})
})
