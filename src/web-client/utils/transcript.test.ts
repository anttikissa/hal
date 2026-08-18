import { expect, test } from 'bun:test'
import type { HistoryEntry } from '../../common/history.ts'
import { webTranscript } from './transcript.ts'

test('live tool text includes cumulative output below the command', () => {
	expect(webTranscript.toolText({
		type: 'tool',
		name: 'bash',
		input: { command: 'for i in {1..5}; do echo "$i"; done' },
		output: '1\n2\n3',
		running: true,
	})).toBe('for i in {1..5}; do echo "$i"; done\n\n1\n2\n3')
})

test('history tool results merge into their call block', () => {
	const history: HistoryEntry[] = [
		{ type: 'tool_call', toolId: 'tool-1', name: 'bash', input: { command: 'printf hello' }, blobId: 'blob-1', ts: '2026-08-13T12:00:00.000Z' },
		{ type: 'tool_result', toolId: 'tool-1', output: 'hello', blobId: 'blob-1', ts: '2026-08-13T12:00:01.000Z' },
	]
	expect(webTranscript.historyItems(history)).toEqual([{
		type: 'tool',
		name: 'bash',
		input: { command: 'printf hello' },
		output: 'hello',
		toolId: 'tool-1',
		blobId: 'blob-1',
		ts: Date.parse('2026-08-13T12:00:00.000Z'),
	}])
})

test('status markers render as prose in history and live notices', () => {
	const result = webTranscript.items({
		session: { id: 's1', cwd: '/tmp' },
		history: [{ type: 'log', text: '[restarted]' }],
		live: [{ type: 'log', text: '[paused before local tools]' }],
	})

	expect(result.map((item) => item.text)).toEqual(['Restarted', 'Paused before local tools'])
})
