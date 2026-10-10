import { expect, test } from 'bun:test'
import { completion } from '../../common/completion.ts'
import { commands } from '../commands.ts'
import { host } from '../host.ts'
import { jobs } from '../jobs.ts'
import { restartNote } from '../restart-note.ts'
import { tabs } from '../tabs.ts'
import { command, restartProcess } from './restart.ts'

const ctx = { sessionId: 's', cwd: '/tmp', model: 'fake/m', setCwd() {}, setModel() {}, say() {} }

test('restart exposes described scopes but explicit completion fills its default, not a partial command', () => {
	for (let input of ['/restart', '/restart ', '/restart  ']) {
		let { items, descriptions } = commands.suggestions(input, ctx)
		expect(items).toEqual(['/restart all', '/restart host', '/restart both', '/restart local'])
		expect(descriptions?.[0]).toContain('(default)')
		expect(descriptions?.every((d) => d.includes('restart') && d !== 'path')).toBe(true)
		expect(completion.apply(input, items).text).toBe('/restart all')
	}
	expect(completion.apply('/rest', commands.complete('/rest', ctx)).text).toBe('/restart ')
	expect(completion.apply('/restart h', commands.complete('/restart h', ctx)).text).toBe('/restart host')
	// Never manufacture a replacement absent from the host response.
	expect(completion.apply('/restart', []).text).toBe('/restart')
	expect(completion.apply('/cd', commands.complete('/cd', ctx)).text).toBe('/cd ')
})

test('a flagged background job makes a model ask the user: two restarts refused, the third goes through', async () => {
	let exits = 0, asks = 0, exit = restartProcess.run, write = restartNote.write, broadcast = host.broadcast, label = tabs.label
	tabs.label = () => 's'
	restartProcess.run = () => void exits++
	restartNote.write = () => {}
	host.broadcast = (_id, event) => void (event.type === 'restart-ask' && asks++)
	jobs.state.running.set('s:7', { sessionId: 's', stop() {}, unsafe: { input: { command: 'migrate', unsafeToStop: true, background: true }, at: Date.now() } })
	try {
		let model = { ...ctx, sender: { origin: 'model' } } as any
		let first = (await command.run('host', undefined, model)) as any
		expect(first.error).toContain('THIS IS UNSAFE. #t7')
		expect(first.error).toContain('Ask the user first')
		expect(((await command.run('host anyway', undefined, model)) as any).error).toContain('THIS IS UNSAFE')
		expect(((await command.run('host', undefined, model)) as any).say).toBe('restarting the host')
		// A human is asked, every time, unless they chose Restart anyway.
		expect(((await command.run('host', undefined, ctx as any)) as any).say).toContain('asking the user')
		expect(((await command.run('host', undefined, model)) as any).error).toContain('THIS IS UNSAFE')
		await Bun.sleep(300)
		expect(exits).toBe(1)
		expect(asks).toBe(4)
	} finally {
		jobs.state.running.delete('s:7')
		restartProcess.run = exit
		restartNote.write = write
		host.broadcast = broadcast
		tabs.label = label
	}
})
