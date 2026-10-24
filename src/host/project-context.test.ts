// Project trust gates executable context; shared directories unload only after the last tab leaves.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { calls, client, created, testHome, until, useHost } from './host-fixture.test.ts'
import { projectContext } from './project-context.ts'
import { plugins } from './plugins.ts'
import { tabs } from './tabs.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { systemPrompt } from './system-prompt.ts'
import { promptFiles } from './prompt-files.ts'
import { forms } from '../common/forms.ts'
import { history } from './history.ts'

useHost()

function project(): string {
	let root = `${testHome()}/project`
	mkdirSync(`${root}/.git`, { recursive: true })
	mkdirSync(`${root}/sub`)
	mkdirSync(`${root}/.agents/plugins/hal`, { recursive: true })
	writeFileSync(`${root}/AGENTS.md`, 'PROJECT INSTRUCTION')
	writeFileSync(
		`${root}/.agents/plugins/hal/test.ts`,
		`export default () => {
  globalThis.projectStarts = (globalThis.projectStarts ?? 0) + 1;
  return () => globalThis.projectStops = (globalThis.projectStops ?? 0) + 1;
}`,
	)
	;(globalThis as any).projectStarts = 0
	;(globalThis as any).projectStops = 0
	return root
}

function tab(c: ReturnType<typeof client>, cwd: string): string {
	let id = created(c, cwd)
	tabs.insert(id, tabs.file().open.length)
	return id
}

test('a durable trust answer gates instructions and plugins; two tabs share one activation and last departure unloads', async () => {
	let root = project(),
		c = client(),
		a = tab(c, root),
		b = tab(c, `${root}/sub`)
	await projectContext.refresh()
	expect((globalThis as any).projectStarts).toBe(0)
	expect(systemPrompt.agents(root)).not.toContain('PROJECT INSTRUCTION')
	expect([...promptFiles.files(a)]).not.toContain(`${root}/AGENTS.md`)
	c.conn.send({ type: 'submit', sessionId: a, text: 'hello' })
	await until(() => c.of('question').length === 1)
	expect(calls).toHaveLength(0)
	let q = c.of('question')[0]!
	projectContext.reset()
	expect(forms.open(history.readSync(a))?.id).toBe(q.id)
	c.conn.send({ type: 'answer', sessionId: a, question: q.id, answers: { project_trust: 'Trust project' } })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.system).toContain('PROJECT INSTRUCTION')
	expect((globalThis as any).projectStarts).toBe(1)
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 1)
	slash.change(a, { cwd: testHome() })
	await projectContext.refresh()
	expect((globalThis as any).projectStops).toBe(0)
	expect(tabs.close(b)).toBeUndefined()
	await projectContext.refresh()
	expect((globalThis as any).projectStops).toBe(1)
	expect(plugins.state.files.has(`${root}/.agents/plugins/hal/test.ts`)).toBe(false)
	tabs.resume(b)
	await projectContext.refresh()
	expect((globalThis as any).projectStarts).toBe(2)
	expect(projectContext.question(root)).toBeUndefined()
	projectContext.reset()
	expect(projectContext.allowed(root)).toBe(true)
	await projectContext.refresh()
	expect((globalThis as any).projectStarts).toBe(3)
})

test('closing a tab rooted at the personal directory keeps personal plugins loaded', async () => {
	let root = project()
	await plugins.init(`${testHome()}/plugins`, `${root}/.agents/plugins/hal`)
	try {
		projectContext.decide(root, true)
		let id = tab(client(), root)
		await projectContext.refresh()
		expect((globalThis as any).projectStarts).toBe(1)
		tabs.close(id)
		await projectContext.refresh()
		projectContext.reset()
		expect((globalThis as any).projectStops).toBe(0)
		expect(plugins.state.files.has(`${root}/.agents/plugins/hal/test.ts`)).toBe(true)
	} finally {
		plugins.close()
	}
})

test('an unreadable open tab does not block another project activation', async () => {
	let root = project()
	projectContext.decide(root, true)
	tab(client(), root)
	tabs.file().open.push('999-missing')
	await projectContext.refresh()
	expect((globalThis as any).projectStarts).toBe(1)
	expect(tabs.list().find((tab) => tab.id === '999-missing')?.state.type).toBe('error')
})

test('/cd asks before changing cwd; declining leaves project content inactive and remembers the decision', async () => {
	let root = project(),
		c = client(),
		id = tab(c, testHome())
	c.conn.send({ type: 'submit', sessionId: id, text: `/cd ${root}` })
	await until(() => c.of('question').length === 1)
	expect(sessions.open(id).cwd).toBe(testHome())
	let q = c.of('question')[0]!
	c.conn.send({
		type: 'answer',
		sessionId: id,
		question: q.id,
		answers: { project_trust: 'Continue without project content' },
	})
	await until(() => sessions.open(id).cwd === root)
	c.conn.send({ type: 'submit', sessionId: id, text: 'hello' })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.system).not.toContain('PROJECT INSTRUCTION')
	expect((globalThis as any).projectStarts).toBe(0)
	expect(projectContext.question(root)).toBeUndefined()
})

test('empty projects ask nothing; new instructions, skills, or plugins ask, but trusted future changes do not', () => {
	for (let file of ['AGENTS.md', '.agents/skills/demo/SKILL.md', '.agents/plugins/hal/demo.ts']) {
		let root = `${testHome()}/${file.split('/').at(-1)}`
		mkdirSync(`${root}/.git`, { recursive: true })
		expect(projectContext.question(root)).toBeUndefined()
		mkdirSync(`${root}/${file.slice(0, file.lastIndexOf('/') + 1)}`, { recursive: true })
		writeFileSync(`${root}/${file}`, '')
		expect(projectContext.question(root)?.quote?.text).toBe(root)
		projectContext.decide(root, true)
		writeFileSync(`${root}/${file}`, 'changed')
		expect(projectContext.question(root)).toBeUndefined()
	}
})

test('trusted repo ancestors apply to nested cwd, not nested Git projects or unrelated non-Git children', () => {
	let root = project()
	projectContext.decide(root, true)
	expect(projectContext.allowed(`${root}/sub`)).toBe(true)
	mkdirSync(`${root}/sub/.git`)
	expect(projectContext.allowed(`${root}/sub`)).toBe(false)
	projectContext.decide(testHome(), true)
	mkdirSync(`${testHome()}/outside`)
	expect(projectContext.allowed(`${testHome()}/outside`)).toBe(false)
})
