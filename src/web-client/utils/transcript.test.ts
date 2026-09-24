import { expect, test } from 'bun:test'
import type { HistoryEntry } from '../../common/history.ts'
import { webTranscript } from './transcript.ts'

test('browser image links use the stored blob rather than the original server path', () => {
	expect(webTranscript.imageHref('05-wan', '000123-abc', 'myToken')).toBe('/images/05-wan/000123-abc?auth=myToken')
	expect(webTranscript.imageHref('05-wan', '../secret', 'myToken')).toBe('')
})
test('paste inspector reads original text from the persisted part, not its display marker', () => {
	expect(webTranscript.pastedText({ type: 'user', id: '000001-abc', parts: [{ type: 'text', text: 'original\ntext', displayText: '[/tmp/hal/paste/0002.txt]' }] })).toBe('original\ntext')
	expect(webTranscript.pastedText({ type: 'user', parts: [{ type: 'text', text: 'Analyze this:\n\noriginal\ntext now', displayText: 'Analyze this:\n\n[/tmp/hal/paste/0002.txt] now' }] })).toBe('original\ntext')
	expect(webTranscript.pastedText({ type: 'user', parts: [{ type: 'text', text: 'ordinary message' }] })).toBe('')
})
test('paste markers split from surrounding prose without losing their text', () => {
	expect(webTranscript.pasteSegments('see [/tmp/hal/paste/0002.txt] now')).toEqual(['see ', '[/tmp/hal/paste/0002.txt]', ' now'])
	expect(webTranscript.isPasteMarker('[/tmp/hal/paste/0002.txt]')).toBe(true)
	expect(webTranscript.isPasteMarker('see [/tmp/hal/paste/0002.txt]')).toBe(false)
})
test('history tool results merge into their call block', () => {
	const history: HistoryEntry[] = [
		{ type: 'tool_call', toolId: 'call_gJTY1EdGkAekFoW0UUhnowp7', name: 'bash', input: { command: 'printf hello' }, blobId: '0403ru-pku', ts: '2026-08-13T12:00:00.000Z' },
		{ type: 'tool_result', toolId: 'call_gJTY1EdGkAekFoW0UUhnowp7', output: 'hello', blobId: '0403ru-pku', ts: '2026-08-13T12:00:01.000Z' },
	]
	expect(webTranscript.historyItems(history)).toEqual([{
		type: 'tool',
		name: 'bash',
		input: { command: 'printf hello' },
		output: 'hello',
		toolId: 'call_gJTY1EdGkAekFoW0UUhnowp7',
		blobId: '0403ru-pku',
		ts: Date.parse('2026-08-13T12:00:00.000Z'),
	}])
})
test('transcript anchors use each visible short block id', () => {
	expect(webTranscript.blockId({ type: 'assistant', id: '0474y5-tv7', text: 'hello' })).toBe('0474y5-tv7')
	expect(webTranscript.blockId({ type: 'tool', blobId: '0403ru-pku', name: 'bash' })).toBe('0403ru-pku')
	expect(webTranscript.blockId({ type: 'thinking', blobId: '0403ru-xyz', text: 'hmm' })).toBe('0403ru-xyz')
})
test('persisted user messages keep every uploaded image reference visible', () => {
	const result = webTranscript.items({
		session: { id: 's1', cwd: '/tmp' },
		meta: { id: 's1', createdAt: '' },
		parentCount: 0,
		history: [{
			type: 'user',
			parts: [
				{ type: 'image', blobId: 'blob-1', originalFile: '/tmp/hal/i/first.jpg' },
				{ type: 'text', text: 'compare ' },
				{ type: 'image', blobId: 'blob-2', originalFile: '/tmp/hal/i/second.jpg' },
				{ type: 'text', text: ' and ' },
				{ type: 'image', blobId: 'blob-3', originalFile: '/tmp/hal/i/third.jpg' },
			],
		}],
		live: [],
	})

	expect(result.map((item) => item.text)).toEqual([
		'[/tmp/hal/i/first.jpg]compare [/tmp/hal/i/second.jpg] and [/tmp/hal/i/third.jpg]',
	])
})

test('status markers render as prose in history and live notices', () => {
	const result = webTranscript.items({
		session: { id: 's1', cwd: '/tmp' },
		meta: { id: 's1', createdAt: '' },
		parentCount: 0,
		history: [{ type: 'log', text: '[restarted]' }],
		live: [{ type: 'log', text: '[paused before local tools]' }],
	})

	expect(result.map((item) => item.text)).toEqual(['Restarted', 'Paused before local tools'])
})

test('model output exposes system-message boundary labels separately from text', () => {
	const interrupted: HistoryEntry = { type: 'assistant', text: 'First.', interruptedBy: 'system-message' }

	expect(webTranscript.interruption(interrupted)).toBe('[interrupted by system message]')
})

test('question rows keep shared projection data and hide queued questions', () => {
	const history: HistoryEntry[] = [
		{ type: 'tool_call', toolId: 'tool-1', name: 'bash', input: { command: 'rm one' } },
		{ type: 'tool_call', toolId: 'tool-2', name: 'edit', input: { path: 'two' } },
		{ type: 'pending_tools', id: 'pending-1', toolIds: ['tool-1', 'tool-2'], cwd: '/tmp', reason: 'questions' },
		{ type: 'question', id: 'question-1', text: 'Allow one?', input: { kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }, source: { type: 'tool', pendingId: 'pending-1', toolId: 'tool-1' } },
		{ type: 'question', id: 'question-2', text: 'Allow two?', input: { kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }, source: { type: 'tool', pendingId: 'pending-1', toolId: 'tool-2' } },
		{ type: 'question', id: 'question-3', text: 'Later?', input: { kind: 'text' }, source: { type: 'intro' } },
		{ type: 'answer', questionId: 'question-1', value: { kind: 'choice', choiceId: 'no' } },
	]

	const questions = webTranscript.items({
		session: { id: 's1', cwd: '/tmp' },
		meta: { id: 's1', createdAt: '' },
		parentCount: 0,
		history,
		live: [],
	}).filter((item) => item.entry.type === 'question')

	expect(questions).toHaveLength(2)
	expect(questions[0]!.entry).toEqual(expect.objectContaining({
		id: 'question-1',
		active: false,
		answer: { kind: 'choice', choiceId: 'no' },
		progress: { index: 1, total: 2 },
		tool: { name: 'bash', input: { command: 'rm one' } },
	}))
	expect(questions[1]!.entry).toEqual(expect.objectContaining({ id: 'question-2', active: true }))
})

test('a replacement snapshot settles the active question into compact history', () => {
	const question: HistoryEntry = { type: 'question', id: 'question-1', text: 'Continue?', input: { kind: 'choice', choices: [{ id: 'continue', label: 'Continue' }] }, source: { type: 'intro' } }
	function snapshot(history: HistoryEntry[]) {
		return webTranscript.items({
			session: { id: 's1', cwd: '/tmp' },
			meta: { id: 's1', createdAt: '' },
			parentCount: 0,
			history,
			live: [],
		})
	}

	expect(snapshot([question])[0]!.entry).toEqual(expect.objectContaining({ id: 'question-1', active: true }))
	expect(snapshot([question, { type: 'answer', questionId: 'question-1', value: { kind: 'choice', choiceId: 'continue' } }])[0]!.entry).toEqual(expect.objectContaining({
		id: 'question-1',
		active: false,
		answer: { kind: 'choice', choiceId: 'continue' },
	}))
})
