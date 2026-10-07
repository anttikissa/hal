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
	expect(rebaseReport.text(snapshot, { base: 130, drop: [43, 50, 95, 110], edit: [] })).toBe('Rebase applied. Dropped 5 entries: #43-95 (3 entries), #104-110 (2 entries)')
	let many = rebaseRows.build(Array.from({ length: 1000 }, (_, n) => prompt(n + 1)))
	expect(rebaseReport.text(many, { base: 1000, drop: many.rows.map((r) => r.n), edit: [] })).toBe('Rebase applied. Dropped 1000 entries: #1-1000 (1000 entries)')
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
