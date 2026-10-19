import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { backfill, type Backfill } from '../common/backfill.ts'
import { replay } from '../common/replay.ts'
import { transcript, type Transcript } from '../common/transcript.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'
import { snapshots } from './snapshots.ts'
import { paths } from './paths.ts'

let savedHome = paths.state.home,
	home = ''
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-rebase-paging-`)
	paths.state.home = home
})
afterEach(() => {
	host.reset()
	sessions.closeAll()
	if (savedHome === undefined) paths.state.home = undefined
	else paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})

function loaded(id: string, incremental: boolean): Transcript {
	let snapshot = snapshots.build(id, pages.snapshot(id, 100))
	let all = new Map<string, Backfill>()
	backfill.onSnapshot(all, { type: 'snapshot', sessionId: id, snapshot })
	let t = transcript.fromSnapshot(snapshot)
	for (let ask; (ask = backfill.next(all, id));) {
		let page = pages.page(id, ask.before, 100)
		backfill.onPage(all, {
			type: 'history',
			sessionId: id,
			before: ask.before,
			records: page.records,
			...(page.start > 0 ? { older: page.start } : {}),
		})
		if (incremental) t = backfill.apply(all, t)
	}
	return backfill.apply(all, t)
}

for (let incremental of [false, true])
	test(`${incremental ? 'incremental' : 'terminal'} backfill keeps rewritten text and dividers across pages and undo`, () => {
		let id = sessions.create({ cwd: '/', model: 'fake/m' }).id
		for (let i = 0; i < 4; i++) {
			history.submit(id, `prompt ${i}`)
			history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${i} ${'x'.repeat(1000)}` } })
			history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		}
		let original = history.readSync(id).slice(),
			drop = original[1]!.n!,
			edit = original[3]!.n!,
			base = original.at(-1)!.n!
		history.append(id, { type: 'rebase', base, drop: [drop], edit: [{ n: edit, text: 'corrected prompt' }] })
		let t = loaded(id, incremental)
		expect(t.items.some((item) => item.key === String(drop))).toBe(false)
		expect(t.items.find((item) => item.key === String(edit))).toMatchObject({
			type: 'prompt',
			text: 'corrected prompt',
		})
		expect(t.items.filter((item) => item.type === 'divider' && item.text.includes('History rewritten'))).toHaveLength(1)
		expect(t.items).toEqual(transcript.fromSnapshot(snapshots.build(id, pages.snapshot(id, Infinity))).items)
		history.append(id, { type: 'rebase', base, drop: [], edit: [] })
		let restored = loaded(id, incremental)
		expect(restored.items.find((item) => item.key === String(drop))).toMatchObject({ type: 'text' })
		expect(restored.items.find((item) => item.key === String(edit))).toMatchObject({ type: 'prompt', text: 'prompt 1' })
		expect(replay.current(history.readSync(id))).toEqual(original)
	})
