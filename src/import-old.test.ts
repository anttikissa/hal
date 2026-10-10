import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from './common/ason.ts'
import { replay, type HistoryRecord } from './common/replay.ts'
import { importer } from './import-old.ts'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

// An old Hal state dir built by hand: sessions/<id>/ with session.ason,
// history logs and blobs, and ipc/state.ason listing the open tabs.
function oldState(sessions: Record<string, { meta?: object; logs: Record<string, object[]>; blobs?: Record<string, object> }>, open: string[]): string {
	let dir = mkdtempSync(`${tmpdir()}/old-hal-`)
	for (let [id, s] of Object.entries(sessions)) {
		let d = `${dir}/sessions/${id}`
		mkdirSync(`${d}/blobs`, { recursive: true })
		writeFileSync(`${d}/session.ason`, ason.stringify({ id, createdAt: '2026-01-01T00:00:00.000Z', workingDir: '/w', model: 'anthropic/claude-x', ...s.meta }))
		for (let [name, recs] of Object.entries(s.logs)) writeFileSync(`${d}/${name}`, recs.map((r) => ason.stringify(r, 'short') + '\n').join(''))
		for (let [b, data] of Object.entries(s.blobs ?? {})) writeFileSync(`${d}/blobs/${b}.ason`, ason.stringify(data))
	}
	mkdirSync(`${dir}/ipc`, { recursive: true })
	writeFileSync(`${dir}/ipc/state.ason`, ason.stringify({ sessions: open.map((id) => ({ id })) }))
	return dir
}

function history(home: string, id: string): HistoryRecord[] {
	return readFileSync(`${home}/sessions/${id}/history.asonl`, 'utf8').split('\n').filter(Boolean).map((l) => ason.parse(l) as HistoryRecord)
}

const t = (m: number) => `2026-01-01T00:${String(m).padStart(2, '0')}:00.000Z`
const user = (text: string, m: number) => ({ type: 'user', parts: [{ type: 'text', text }], ts: t(m) })
const texts = (recs: HistoryRecord[]) => replay.toMessages(recs).flatMap((m) => m.blocks.flatMap((b) => (b.type === 'text' && !b.text.startsWith('<hal-note>') ? [b.text.split('\n').at(-1)] : [])))

test('a fork of a fork holds each parent up to its fork time, then its own records', () => {
	let dir = oldState(
		{
			'1-a': { logs: { 'history.asonl': [user('a1', 1), { type: 'assistant', text: 'r1', ts: t(2) }, { type: 'turn_end', status: 'completed', ts: t(3) }, user('a2', 10)] } },
			'2-b': { logs: { 'history.asonl': [{ type: 'forked_from', parent: '1-a', ts: t(5) }, user('b1', 6), { type: 'turn_end', status: 'completed', ts: t(7) }, user('b2', 20), { type: 'turn_end', status: 'completed', ts: t(21) }] } },
			'3-c': { logs: { 'history.asonl': [{ type: 'forked_from', parent: '2-b', ts: t(8) }, user('c1', 9), { type: 'turn_end', status: 'aborted', ts: t(9) }] } },
		},
		['3-c', '1-a'],
	)
	let home = mkdtempSync(`${tmpdir()}/new-hal-`)
	importer.importOld(dir, home)
	expect(texts(history(home, '3-c'))).toEqual(['a1', 'r1', 'b1', 'c1'])
	expect(texts(history(home, '2-b'))).toEqual(['a1', 'r1', 'b1', 'b2'])
	let recs = history(home, '3-c')
	expect(recs.map((r) => r.n)).toEqual(recs.map((_, i) => i + 1))
	expect(recs.at(-1)).toMatchObject({ type: 'turn_end', status: 'paused' })
	expect(ason.parse(readFileSync(`${home}/state/tabs.ason`, 'utf8'))).toMatchObject({ open: ['3-c', '1-a'] })
	expect(ason.parse(readFileSync(`${home}/sessions/2-b/session.ason`, 'utf8'))).toMatchObject({ id: '2-b', cwd: '/w', model: 'anthropic/claude-x' })
})

test('a rebased session imports its current log only', () => {
	let dir = oldState(
		{
			'1-a': {
				meta: { currentLog: 'history2.asonl' },
				logs: {
					'history.asonl': [user('old', 1), { type: 'rebased_to', log: 'history2.asonl', ts: t(2) }],
					'history2.asonl': [{ type: 'rebased_from', log: 'history.asonl', ts: t(2) }, user('new', 3)],
				},
			},
		},
		[],
	)
	let home = mkdtempSync(`${tmpdir()}/new-hal-`)
	importer.importOld(dir, home)
	expect(texts(history(home, '1-a'))).toEqual(['new'])
})

test('blob-backed thinking, calls and results are written inline and paired, a steering prompt after the results', () => {
	let dir = oldState(
		{
			'1-a': {
				logs: {
					'history.asonl': [
						user('go', 1),
						{ type: 'thinking', model: 'openai/gpt-x', blobId: 'th', ts: t(2) },
						{ type: 'tool_call', toolId: 'c1', name: 'bash', blobId: 'b1', ts: t(3) },
						{ type: 'user', parts: [{ type: 'text', text: 'steer' }], status: 'steering', ts: t(4) },
						{ type: 'tool_result', toolId: 'c1', blobId: 'b1', ts: t(5) },
						{ type: 'turn_end', status: 'completed', ts: t(6) },
					],
				},
				blobs: { th: { thinking: 'hmm', signature: '{"encrypted_content":"e"}' }, b1: { call: { name: 'bash', input: { command: 'ls' } }, result: { content: 'files', status: 'error' } } },
			},
		},
		[],
	)
	let home = mkdtempSync(`${tmpdir()}/new-hal-`)
	importer.importOld(dir, home)
	let msgs = replay.toMessages(history(home, '1-a'))
	let blocks: { type: string }[] = msgs.flatMap((m): { type: string }[] => m.blocks)
	expect(blocks.find((b) => b.type === 'thinking')).toMatchObject({ text: 'hmm', signature: '{"encrypted_content":"e"}', provider: 'openai' })
	expect(blocks.find((b) => b.type === 'tool_call')).toMatchObject({ id: 'c1', name: 'Action', input: { action: "BASH { command: 'ls' }" } })
	// Replay prefixes a block header to the output.
	expect(blocks.find((b) => b.type === 'tool_result')).toMatchObject({ id: 'c1', output: expect.stringMatching(/\nfiles$/), isError: true })
	expect(texts(history(home, '1-a')).at(-1)).toBe('steer')
})

test('an image is copied as a Hal blob, also into a fork that inherits it; an open question becomes output, not a live question', () => {
	let dir = oldState(
		{
			'1-a': {
				logs: {
					'history.asonl': [
						{ type: 'user', parts: [{ type: 'text', text: 'see' }, { type: 'image', blobId: 'im' }], ts: t(1) },
						{ type: 'question', id: 'q', text: 'Pick?', input: { kind: 'text' }, source: { type: 'intro' }, ts: t(2) },
					],
				},
				blobs: { im: { media_type: 'image/png', data: png.toString('base64') } },
			},
			'2-b': { logs: { 'history.asonl': [{ type: 'forked_from', parent: '1-a', ts: t(9) }] } },
		},
		[],
	)
	let home = mkdtempSync(`${tmpdir()}/new-hal-`)
	importer.importOld(dir, home)
	for (let id of ['1-a', '2-b']) {
		let recs = history(home, id)
		expect(recs[0]).toMatchObject({ type: 'user', blocks: [{ type: 'text', text: 'see' }, { type: 'image', blob: 'im', mediaType: 'image/png' }] })
		expect(readFileSync(`${home}/sessions/${id}/blobs/im.png`)).toEqual(png)
		expect(recs.some((r) => r.type === 'question')).toBe(false)
		expect(recs.some((r) => r.type === 'output' && r.text === 'Pick?')).toBe(true)
	}
})

test('refuses a home that has sessions, and leaves the old state as it was', () => {
	let dir = oldState({ '1-a': { logs: { 'history.asonl': [user('x', 1)] } } }, [])
	let before = readFileSync(`${dir}/sessions/1-a/history.asonl`, 'utf8')
	let home = mkdtempSync(`${tmpdir()}/new-hal-`)
	importer.importOld(dir, home)
	expect(() => importer.importOld(dir, home)).toThrow('already has sessions')
	expect(readFileSync(`${dir}/sessions/1-a/history.asonl`, 'utf8')).toBe(before)
	expect(existsSync(`${dir}/sessions/1-a/marks.ason`)).toBe(false)
})
