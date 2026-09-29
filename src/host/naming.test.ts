import { expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { client, calls, created, restartHost, until, useHost } from './host-fixture.test.ts'
import { sessions } from './sessions.ts'
import { naming } from './naming.ts'
import { history } from './history.ts'
import { paths } from './paths.ts'
import { ason } from '../common/ason.ts'
import { names } from '../common/names.ts'

useHost()

test('automatic titles schedule across restart, replay originals, and yield to manual ownership', async () => {
	let c = client(), id = created(c)
	naming.manual(id)
	for (let turn = 1; turn <= 8; turn++) {
		let at = calls.length
		c.conn.send({ type: 'submit', sessionId: id, text: `Repair replay turn ${turn}` })
		await until(() => calls.length > at)
		let eligible = [1, 2, 3, 7].includes(turn)
		expect(JSON.stringify(calls[at]!.input.messages.at(-1)).includes('Check whether')).toBe(eligible)
		if (turn === 1) expect(sessions.open(id).name).toBe('Repair replay turn 1')
		if (turn === 7) naming.manual(id, 'Human title wins')
		calls[at]!.push({ type: 'text', text: 'Done.\n<rename>Repair durable provider replay</rename>' }, { type: 'done', reason: 'end' })
		await until(() => !history.state.running.has(id))
		if (turn === 1) expect(sessions.open(id).name).toBe('Repair durable provider replay')
		if (turn >= 7) expect(sessions.open(id).name).toBe('Human title wins')
		if (turn === 3) { restartHost(); c = client(); c.conn.send({ type: 'open', sessionId: id }); await until(() => c.views.has(id)) }
	}
	let original = history.readSync(id).find((r) => r.type === 'assistant' && r.block.type === 'text')
	expect(original?.type === 'assistant' && original.block.type === 'text' && original.block.text).toContain('<rename>')
})

test('backfill lazily persists excerpts and preserves legacy and explicit names; corruption is explicit', async () => {
	let c = client(), unnamed = created(c), manual = created(c), empty = created(c)
	for (let id of [unnamed, manual, empty]) {
		let meta = { ...sessions.open(id) }
		delete meta.nameOwner; delete meta.nameVersion; delete meta.nameTurns
		if (id === manual) meta.name = 'Existing meaningful title'
		else delete meta.name
		sessions.close(id)
		writeFileSync(`${paths.sessionDir(id)}/session.ason`, ason.stringify(meta))
	}
	writeFileSync(history.file(unnamed), ason.stringify({ type: 'user', blocks: [{ type: 'text', text: 'Improve lazy session loading' }], ts: '2026-01-01' }, 'short') + '\n')
	let progress: string[] = []
	await naming.backfill((text) => progress.push(text))
	expect(sessions.open(unnamed).name).toBe('Improve lazy session loading')
	expect(sessions.open(manual).name).toBe('Existing meaningful title')
	expect(sessions.open(empty).name).toBe(names.fallback(empty))
	expect(progress.at(-1)).toContain('3 scanned, 2 named')
	let broken = created(c)
	delete sessions.open(broken).nameOwner; delete sessions.open(broken).name
	sessions.close(broken)
	writeFileSync(history.file(broken), '{ broken\n')
	await expect(naming.backfill(() => {})).rejects.toThrow(history.file(broken))
})


test('backfill yields to manual rename and a second invocation cancels it', async () => {
	let id = created(client())
	naming.manual(id)
	let original = naming.firstText
	let release: () => void = () => {}
	let entered = false
	naming.firstText = async () => {
		entered = true
		await new Promise<void>((resolve) => { release = resolve })
		return 'Background excerpt must not win'
	}
	try {
		let progress: string[] = []
		let walk = naming.backfill((text) => progress.push(text))
		await until(() => entered)
		naming.manual(id, 'Human title')
		await naming.backfill((text) => progress.push(text))
		release()
		await walk
		expect(sessions.open(id).name).toBe('Human title')
		expect(progress.join('\n')).toContain('cancelled')
	} finally { release(); naming.firstText = original }
})
