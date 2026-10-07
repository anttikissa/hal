import { expect, test } from 'bun:test'
import { rebaseRows } from '../common/rebase-rows.ts'
import { markdown } from '../common/markdown.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { rebaseReport } from './rebase-report.ts'
import { textDiff } from './text-diff.ts'
import { useHost } from './host-fixture.test.ts'

useHost()
const ts = '2026-10-07T08:00:00Z'
const prompt = (n: number, text = 'deleted text'): HistoryRecord => ({ type: 'user', n, ts, blocks: [{ type: 'text', text }] })

test('rebase reports sparse consecutive entries and implicit grouped drops, not deleted content', () => {
	let records: HistoryRecord[] = [prompt(1), prompt(43), prompt(50), prompt(95), prompt(100),
		{ type: 'assistant', n: 104, ts, block: { type: 'thinking', text: 'signed thought', signature: 'sig' } },
		{ type: 'assistant', n: 110, ts, block: { type: 'tool_call', id: 'call', name: 'bash', input: { command: 'ls' } } },
		{ type: 'user', n: 120, ts, blocks: [{ type: 'tool_result', id: 'call', output: 'result' }] }, prompt(130)]
	let snapshot = rebaseRows.build(records)
	expect(rebaseReport.text(snapshot, { base: 130, drop: [43, 50, 95, 110], edit: [] })).toBe('Rebase applied (dropped 5 entries, edited 0)\nDropped 5 entries: #43-95 (3 entries), #104-110 (2 entries)')
	let many = rebaseRows.build(Array.from({ length: 1000 }, (_, n) => prompt(n + 1)))
	expect(rebaseReport.text(many, { base: 1000, drop: many.rows.map((r) => r.n), edit: [] })).toBe('Rebase applied (dropped 1000 entries, edited 0)\nDropped 1000 entries: #1-1000 (1000 entries)')
})

test('edit diffs preserve header-like content and backticks inside a safe diff fence', () => {
	let before = 'start\n-- old\n```\nlast\n', after = 'start\n++ new\n```\nlast\n'
	let report = rebaseReport.text(rebaseRows.build([prompt(1, before)]), { base: 1, drop: [], edit: [{ n: 1, text: after }] })
	let code = markdown.parse(report).filter((b) => b.type === 'code')
	expect(code).toHaveLength(1)
	expect(code[0]!.lang).toBe('diff')
	expect(code[0]!.lines).toContain('--- old')
	expect(code[0]!.lines).toContain('+++ new')
	expect(code[0]!.lines).toContain(' ```')
	expect(textDiff.text('same', 'same')).toBe('')
	expect(textDiff.text('old\n', 'new\n', 1)).toBe('-old\n… 1 more lines')
})

test('compact report shows counts and continuation, preserving ranges, IDs and pause in full detail', () => {
	let snapshot = rebaseRows.build([prompt(169, 'old'), ...Array.from({ length: 11 }, (_, n) => prompt(n + 170))])
	let report = rebaseReport.text(snapshot, { base: 180, drop: snapshot.rows.slice(1).map((r) => r.n), edit: [{ n: 169, text: 'replacement' }] }, true)
	expect(report.split('\n')[0]).toBe('Rebase applied (dropped 11 entries, edited 1)')
	expect(report).toContain('#170-180 (11 entries)')
	expect(report).toContain('Edited #169')
	expect(report).toContain('\n--paused\n')
	for (let continuation of ['prompt', 'unfinished'] as const) expect(rebaseReport.text(snapshot, { base: 180, drop: [], edit: [] }, false, continuation).split('\n')[0]).toBe(`Rebase applied (dropped 0 entries, edited 0; continuing ${continuation === 'prompt' ? 'after user prompt' : 'unfinished turn'})`)
	expect(report).toContain('-old')
	expect(report).toContain('+replacement')
})

test('rebase omits newline metadata but preserves literal edited content', () => {
	let marker = '\\ No newline at end of file'
	let report = rebaseReport.text(rebaseRows.build([prompt(1, 'old')]), { base: 1, drop: [], edit: [{ n: 1, text: `new\n${marker}` }] })
	let code = markdown.parse(report).find((b) => b.type === 'code')!
	expect(code.lines).toEqual(['-old', '+new', `+${marker}`])
	// File diff consumers still receive the metadata.
	expect(textDiff.text('old', 'new')).toContain(`\n${marker}`)
})
