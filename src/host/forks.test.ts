import { expect, test } from 'bun:test'
import { titles } from '../common/titles.ts'
import { transcript } from '../common/transcript.ts'
import { replay } from '../common/replay.ts'
import { subagents } from './subagents.ts'
import { history } from './history.ts'
import { useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'

useHost()

test('nested forks retain message origins without changing provider replay or marking new messages', () => {
	let parent = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	history.submit(parent, 'first prompt')
	history.append(parent, { type: 'assistant', block: { type: 'text', text: 'first answer' } })
	history.append(parent, { type: 'command', text: '/help' })
	let child = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	subagents.fork(parent, child)
	history.submit(child, 'second prompt')
	history.append(child, { type: 'assistant', block: { type: 'text', text: 'second answer' } })
	let grandchild = sessions.create({ cwd: '/tmp', model: 'fake/m1' }).id
	subagents.fork(child, grandchild)
	let records = history.readSync(grandchild)
	let items = records.flatMap((r) => transcript.recordItems(r, 0))
	expect(items.filter((i) => i.type === 'prompt' || i.type === 'text' || i.type === 'command').map((i) => titles.who(i))).toEqual([
		`You (in ${parent})`, `Hal (in ${parent})`, `You (in ${parent})`, `You (in ${child})`, `Hal (in ${child})`,
	])
	expect(replay.toMessages(records)).toEqual(replay.toMessages(history.readSync(child)))
	history.submit(grandchild, 'new here')
	let fresh = transcript.recordItems(history.readSync(grandchild).at(-1)!, 0)[0]!
	expect(titles.who(fresh)).toBe('You')
	expect(fresh.originSession).toBeUndefined()
})
