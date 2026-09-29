import { afterEach, expect, test } from 'bun:test'
import { notices } from './notices.ts'

const saved = { ttl: notices.ttl, onChange: notices.onChange }
afterEach(() => {
	Object.assign(notices, saved)
	notices.reset()
})

const done = (session: string, tab: number) => notices.fromEvent({ type: 'notice', session, tab, name: `S${tab}`, kind: 'done', line: 'ok' })

test('beyond three, the oldest fold into one line naming their tabs; newest stays last', () => {
	for (let tab = 1; tab <= 5; tab++) notices.add(done(`s${tab}`, tab))
	let folded = notices.fold(notices.state.entries)
	expect(folded.shown.map((n) => n.tab)).toEqual([3, 4, 5])
	expect(notices.moreText(folded.more!)).toBe('+2 more (1, 2)')
	expect(notices.fold(notices.state.entries.slice(0, 3)).more).toBeUndefined()
})

test('a newer notice from the same session replaces the old one and moves to the bottom', () => {
	notices.add(done('a', 1))
	notices.add(done('b', 2))
	notices.add({ ...done('a', 1), kind: 'failed', line: 'boom' })
	expect(notices.state.entries.map((n) => [n.session, n.kind])).toEqual([['b', 'done'], ['a', 'failed']])
})

test('each notice goes after its time, one that stays only when its source removes it', async () => {
	notices.ttl = () => 20
	let changes = 0
	notices.onChange = () => void changes++
	notices.add(done('a', 1))
	notices.add({ key: 'files', kind: 'attention', title: 'changed files', line: '3', stays: true })
	await Bun.sleep(60)
	expect(notices.state.entries.map((n) => n.key)).toEqual(['files'])
	expect(changes).toBe(3)
	notices.remove('files')
	expect(notices.state.entries).toEqual([])
	expect(notices.state.timer).toBeUndefined()
})
