import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ason } from '../src/utils/ason.ts'
import { migrateHistoryEntries, migrateHistoryFile } from './rollover-flat-history.ts'

test('migrateHistoryEntries converts legacy history to flat entries', () => {
	const ts = '2026-04-13T14:43:49.970Z'
	const entries: any[] = [
		{ role: 'user', content: 'hello', source: 'cli', ts },
		{
			role: 'assistant',
			text: 'Let me check.',
			thinkingBlobId: '000aaa-111',
			tools: [{ id: 'tool-1', name: 'read', blobId: '000bbb-222' }],
			usage: { input: 12, output: 34 },
			ts,
		},
		{ role: 'tool_result', tool_use_id: 'tool-1', blobId: '000bbb-222', ts },
		{
			type: 'thinking',
			blobId: '000ccc-333',
			text: 'preview',
			signature: 'sig',
			provider: 'anthropic',
			responseId: 'resp-1',
			ts,
		},
	]

	expect(migrateHistoryEntries(entries)).toEqual([
		{ type: 'user', parts: [{ type: 'text', text: 'hello' }], source: 'cli', ts },
		{ type: 'thinking', blobId: '000aaa-111', ts },
		{ type: 'assistant', text: 'Let me check.', usage: { input: 12, output: 34 }, ts },
		{ type: 'tool_call', toolId: 'tool-1', name: 'read', blobId: '000bbb-222', ts },
		{ type: 'tool_result', toolId: 'tool-1', blobId: '000bbb-222', ts },
		{ type: 'thinking', blobId: '000ccc-333', provider: 'anthropic', responseId: 'resp-1', ts },
	])
})

test('migrateHistoryFile rewrites logs in place and keeps a dated backup', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-flat-rollover-'))
	const path = join(dir, 'history.asonl')
	const ts = '2026-04-13T14:43:49.970Z'
	const original = [
		"{ role: 'user', content: 'hello', ts: '2026-04-13T14:43:49.970Z' }",
		"{ role: 'assistant', ts: '2026-04-13T14:43:49.970Z', thinkingBlobId: '000aaa-111', text: 'ok' }",
	].join('\n') + '\n'
	writeFileSync(path, original)

	try {
		const result = migrateHistoryFile(path, '2026-04-13')
		expect(result.changed).toBe(true)
		expect(result.backupPath).toBe(`${path}.pre-flat-2026-04-13`)
		expect(existsSync(result.backupPath!)).toBe(true)
		expect(readFileSync(result.backupPath!, 'utf-8')).toBe(original)

		const migrated = ason.parseAll(readFileSync(path, 'utf-8')) as any[]
		expect(migrated).toEqual([
			{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts },
			{ type: 'thinking', blobId: '000aaa-111', ts },
			{ type: 'assistant', text: 'ok', ts },
		])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
