import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Command, Event } from '../common/protocol.ts'
import { rebaseRows } from '../common/rebase-rows.ts'
import { rebaseEditor } from './rebase-editor.ts'

test('editor opens full record text, keeps files until host accepts, and retains rejected or failed edits', async () => {
	let tmp = mkdtempSync(join(tmpdir(), 'hal-editor-test-')), oldTmp = process.env.TMPDIR, saved = rebaseEditor.edit
	process.env.TMPDIR = tmp
	let snapshot = rebaseRows.build([{ type: 'user', n: 1, ts: '2026-10-04T09:00:00Z', blocks: [{ type: 'text', text: 'full\noriginal text' }] }])
	let event: Event & { type: 'rebase-plan' } = { type: 'rebase-plan', sessionId: 's1', snapshot, todo: rebaseRows.render('s1', snapshot) }
	let commands: Command[] = [], reports: string[] = [], paths: string[] = []
	try {
		rebaseEditor.edit = async (path) => {
			paths.push(path)
			expect(statSync(path).mode & 0o777).toBe(0o600)
			let text = readFileSync(path, 'utf8')
			if (path.endsWith('todo.txt')) writeFileSync(path, text.replace('keep  #1', 'edit  #1'))
			else { expect(text).toBe('full\noriginal text'); writeFileSync(path, 'replacement') }
		}
		await rebaseEditor.open(event, (c) => commands.push(c), (s) => reports.push(s))
		let command = commands.at(-1) as Command & { type: 'rebase-apply' }
		expect(command).toMatchObject({ type: 'rebase-apply', replacements: { 1: 'replacement' } })
		expect(paths).toHaveLength(2)
		expect(existsSync(command.recoveryPath!)).toBe(true)
		rebaseEditor.result({ type: 'rebase-result', sessionId: 's1', command: command.id, ok: false, text: `stale; kept ${command.recoveryPath}` }, (s) => reports.push(s))
		expect(readFileSync(paths[1]!, 'utf8')).toBe('replacement')
		await rebaseEditor.open(event, (c) => commands.push(c), (s) => reports.push(s))
		let accepted = commands.at(-1) as typeof command
		rebaseEditor.result({ type: 'rebase-result', sessionId: 's1', command: accepted.id, ok: true, text: 'History rewritten.' }, (s) => reports.push(s))
		expect(existsSync(accepted.recoveryPath!)).toBe(false)
		rebaseEditor.edit = async () => { throw new Error('editor failed with full stderr') }
		await rebaseEditor.open(event, (c) => commands.push(c), (s) => reports.push(s))
		expect(commands.at(-1)).toMatchObject({ type: 'rebase-error', text: expect.stringContaining('editor failed with full stderr\nRebase files kept at ') })
		expect(rebaseEditor.busy).toBe(false)
	} finally {
		rebaseEditor.edit = saved
		rebaseEditor.pending.clear()
		if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp
		rmSync(tmp, { recursive: true, force: true })
	}
})
