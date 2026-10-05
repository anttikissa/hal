import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { client, created, testHome, useHost } from './host-fixture.test.ts'
import { promptFiles } from './prompt-files.ts'
import { promptTrail } from './prompt-trail.ts'
import { history } from './history.ts'
import { replay } from '../common/replay.ts'
import { systemPrompt } from './system-prompt.ts'

useHost()

test('AGENTS.md changes reach only tabs they apply to; SYSTEM.md and its includes reach all', () => {
	let root = `${testHome()}/proj`, other = `${testHome()}/other`
	mkdirSync(`${root}/.git`, { recursive: true }); mkdirSync(`${root}/sub`); mkdirSync(other)
	let system = `${testHome()}/SYSTEM.md`
	writeFileSync(system, 'v1\n@inc.md\n'); writeFileSync(`${testHome()}/inc.md`, 'i1'); writeFileSync(`${root}/AGENTS.md`, 'v1')
	let file = systemPrompt.file
	systemPrompt.file = () => system
	try {
		let a = client(), b = client()
		let inProj = created(a, `${root}/sub`), elsewhere = created(b, other)
		let got = { a: [] as any[], b: [] as any[] }
		let watchers = [{ visible: inProj, deliver: (e: any) => got.a.push(e) }, { visible: elsewhere, deliver: (e: any) => got.b.push(e) }]
		promptFiles.check(watchers) // first sight: remembered, nothing shown
		expect(got).toEqual({ a: [], b: [] })

		writeFileSync(`${root}/AGENTS.md`, 'v2')
		writeFileSync(`${root}/sub/CLAUDE.md`, 'new')
		writeFileSync(`${other}/../AGENTS.md`, 'outside every project')
		promptFiles.check(watchers)
		expect(got.a.map((e) => [e.name, e.what])).toEqual([['AGENTS.md', 'changed'], ['CLAUDE.md', 'created']])
		expect(got.b).toEqual([])

		writeFileSync(`${testHome()}/inc.md`, 'i2'); rmSync(`${root}/AGENTS.md`)
		promptFiles.check(watchers)
		expect(got.a.slice(2).map((e) => [e.name, e.what])).toEqual([['inc.md', 'changed'], ['AGENTS.md', 'deleted']])
		expect(got.b.map((e) => [e.name, e.what, e.session])).toEqual([['inc.md', 'changed', elsewhere]])
		writeFileSync(system, 'v2\n@inc.md\n')
		promptFiles.check(watchers)
		expect(got.b.map((e) => e.name)).toEqual(['inc.md', 'SYSTEM.md'])
	} finally {
		systemPrompt.file = file
	}
})

test('an AGENTS.md edit leaves one trail record the model reads on its next request', async () => {
	let root = `${testHome()}/trail`
	mkdirSync(`${root}/.git`, { recursive: true })
	writeFileSync(`${root}/AGENTS.md`, 'Be terse.\n')
	let id = created(client(), root)
	promptTrail.check(id) // first sight: remembered
	writeFileSync(`${root}/AGENTS.md`, 'Be terse.\nSay HOLA first.\n')
	promptTrail.check(id)
	promptTrail.check(id) // unchanged since: nothing more
	let records = history.readSync(id).filter((r) => r.type === 'output')
	expect(records.map((r) => r.type === 'output' && r.change)).toEqual([{ name: 'AGENTS.md', what: 'changed', diff: ' Be terse.\n+Say HOLA first.' }])
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'hello' }] })
	let text = JSON.stringify(replay.toMessages(history.readSync(id)))
	expect(text).toContain('+Say HOLA first.')
})
