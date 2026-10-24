// Tests the Pi-to-Hal command, process and message boundaries (task 0zp).
import '../src/host/host.ts'
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { install, type PiAPI } from './pi-compat.ts'
import { plugins, type Loaded } from '../src/host/plugins.ts'
import { commands } from '../src/host/commands.ts'
import { commandList } from '../src/common/commands/list.ts'
import { sessions } from '../src/host/sessions.ts'
import { slash } from '../src/host/slash.ts'
import { turns } from '../src/host/turns.ts'
import { history } from '../src/host/history.ts'
import { prompts } from '../src/host/prompts.ts'
import { status } from '../src/host/status.ts'
import { testHome, useHost } from '../src/host/host-fixture.test.ts'

useHost()
let entries: Loaded[] = []
afterEach(() => {
	for (let entry of entries.reverse()) plugins.deactivate(entry)
	entries = []
})
function enable(factory: (pi: PiAPI) => void) {
	let entry: Loaded = { path: join(testHome(), `pi-${entries.length}.ts`), hash: '', hooks: [], open: true }
	entries.push(entry)
	entry.cleanup = install(plugins.api(entry), factory, { simplify: ['--staged', '--ref='] })
	delete entry.open
	return entry
}
function context(name = 'repo') {
	let cwd = join(testHome(), name)
	mkdirSync(cwd, { recursive: true })
	return slash.context(sessions.create({ cwd, model: 'openai/gpt-6-astra' }).id)
}
function run(ctx: ReturnType<typeof context>, args = '', name = 'simplify') {
	return commands.all().get(name)!.run(args, undefined, ctx)
}
function intercept() {
	let entry: Loaded = { path: join(testHome(), 'test.ts'), hash: '', hooks: [], open: true }
	entries.push(entry)
	return plugins.api(entry)
}

test('discovery, help, argument completion, collisions, unsupported APIs and reload', async () => {
	let factory = (pi: PiAPI) => pi.registerCommand('simplify', { description: 'Simplify changed lines', handler() {} })
	let entry = enable(factory),
		ctx = context()
	expect(commandList.byName('simplify')?.description).toBe('Simplify changed lines')
	expect(commands.suggestions('/simp', ctx).items).toEqual(['/simplify '])
	expect(commands.complete('/simplify file.ts --', ctx)).toEqual([
		'/simplify file.ts --staged',
		'/simplify file.ts --ref=',
	])
	expect((await commands.all().get('help')!.run('simplify', undefined, ctx)).say).toContain('--staged')
	expect(() => enable(factory)).toThrow('collision /simplify')
	expect(() => enable((pi) => pi.registerCommand('help', { handler() {} }))).toThrow('collision /help')
	expect(() => enable((pi) => (pi as any).on('turn_end', () => {}))).toThrow('unsupported pi.on')
	plugins.deactivate(entry)
	expect(commands.all().has('simplify')).toBe(false)
	expect(commandList.byName('simplify')).toBeUndefined()
	enable(factory)
	expect(await run(ctx)).toEqual({})
})

test('concurrent commands keep cwd, notices and queued literal prompts in their own sessions', async () => {
	let a = context('a'),
		b = context('b'),
		started: string[] = []
	intercept().around(turns, 'start', (_next, id) => {
		started.push(id)
	})
	enable((pi) =>
		pi.registerCommand('simplify', {
			async handler(args, ctx) {
				let result = await pi.exec('pwd', [])
				expect(result).toMatchObject({ code: 0, killed: false, stderr: '' })
				expect(result.stdout.trim()).toBe(ctx.cwd)
				ctx.ui.notify(result.stdout.trim())
				pi.sendUserMessage(args, { deliverAs: 'followUp' })
			},
		}),
	)
	expect(await Promise.all([run(a, '/pause'), run(b, 'second')])).toEqual([{}, {}])
	expect(started.sort()).toEqual([a.sessionId, b.sessionId].sort())
	let records = history.readSync(a.sessionId)
	expect(records.some((r) => r.type === 'output' && r.text.includes(a.cwd))).toBe(true)
	expect(
		records.some(
			(r) =>
				r.type === 'user' &&
				r.blocks.some((v) => v.type === 'text' && v.text === '/pause' && v.label === 'Pi /simplify'),
		),
	).toBe(true)
	expect(await run(a, 'queued')).toEqual({})
	expect(started).toHaveLength(2)
	expect(status.inboxOf(a.sessionId)).toMatchObject([{ text: 'queued', delivery: 'after-turn', label: 'Pi /simplify' }])
	expect(status.inboxOf(b.sessionId)).toEqual([])
	turns.stop(a.sessionId)
	expect(await run(a, 'paused')).toEqual({})
	expect(started).toHaveLength(2)
	expect(status.inboxOf(a.sessionId).map((message) => message.text)).toEqual(['queued', 'paused'])
})

test('exec preserves argv, output and visible failures; message rejection reaches the caller', async () => {
	let ctx = context(),
		output: string[] = []
	ctx.say = (text) => output.push(text)
	enable((pi) =>
		pi.registerCommand('simplify', {
			async handler(args) {
				if (args === 'send') {
					pi.sendUserMessage('hello', { deliverAs: 'followUp' })
					return
				}
				let result = await pi.exec(args === 'missing' ? '/no-such-pi-command' : 'printf', [
					'%s',
					'$(echo not-a-shell); *',
				])
				expect(result.stdout).toBe('$(echo not-a-shell); *')
				let failed = await pi.exec('git', ['not-a-git-command'])
				expect(failed.code).not.toBe(0)
				expect(failed.stderr).toContain('not-a-git-command')
			},
		}),
	)
	expect(await run(ctx)).toEqual({})
	expect(output.join('\n')).toContain('stderr:')
	expect((await run(ctx, 'missing')).error).toContain('/no-such-pi-command')
	intercept().around(prompts, 'submit', () => 'refused in fixture')
	expect((await run(ctx, 'send')).error).toContain('refused in fixture')
})

test('timeout, explicit abort, pause and unload cancel work and prohibit late messages', async () => {
	let ctx = context(),
		sent: string[] = [],
		started = Promise.withResolvers<void>()
	intercept().around(prompts, 'submit', (_next, _id, text) => {
		sent.push(text)
	})
	let entry = enable((pi) =>
		pi.registerCommand('simplify', {
			async handler(args) {
				let controller = new AbortController()
				if (args === 'abort') controller.abort()
				let pending = pi.exec('sleep', ['30'], { timeout: args === 'timeout' ? 10 : 30_000, signal: controller.signal })
				started.resolve()
				try {
					await pending
				} finally {
					pi.sendUserMessage('late', { deliverAs: 'followUp' })
				}
			},
		}),
	)
	expect((await run(ctx, 'timeout')).error).toContain('timed out')
	expect((await run(ctx, 'abort')).error).toContain('aborted')
	sent.length = 0
	started = Promise.withResolvers<void>()
	let paused = run(ctx)
	await started.promise
	turns.stop(ctx.sessionId)
	expect((await paused).error).toContain('aborted')
	expect(sent).toEqual([])
	started = Promise.withResolvers<void>()
	let unloading = run(ctx)
	await started.promise
	plugins.deactivate(entry)
	expect((await unloading).error).toContain('no active command invocation')
	expect(sent).toEqual([])
})
