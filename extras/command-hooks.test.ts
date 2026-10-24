// Compatibility contracts keep policy failures visible and untrusted commands inert (task sey).
import '../src/host/host.ts'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { install } from './command-hooks.ts'
import { load, matches, type Flavor, type Hook } from './hook-sources.ts'
import { command, dispatch } from './hook-command.ts'
import { plugins, type Loaded } from '../src/host/plugins.ts'
import { tools } from '../src/host/tools.ts'
import { roundStream } from '../src/host/round-stream.ts'
import { history } from '../src/host/history.ts'
import { sessions } from '../src/host/sessions.ts'
import { paths } from '../src/host/paths.ts'
import { testHome, useHost } from '../src/host/host-fixture.test.ts'

useHost()
let entries: Loaded[] = []
afterEach(() => {
	for (let entry of entries.reverse()) plugins.deactivate(entry)
	entries = []
})
function config(hooks: Record<string, unknown>, name = 'hooks.json') {
	let path = join(testHome(), name)
	writeFileSync(path, JSON.stringify({ hooks }))
	return path
}
function enable(path: string, flavor: Flavor = 'claude') {
	let source = { path, sha256: load(flavor, { path, sha256: '' }).hash }
	let entry: Loaded = { path: join(testHome(), `${flavor}.ts`), hash: '', hooks: [], open: true }
	entries.push(entry)
	entry.cleanup = install(plugins.api(entry), flavor, { cwd: testHome(), sources: [source] })
	delete entry.open
}
function handler(command: string) {
	return [{ hooks: [{ type: 'command', command }] }]
}
function hook(command: string, event = 'PreToolUse'): Hook {
	return { source: 'fixture', event, handler: { command, timeout: 2 } }
}
function context() {
	return { cwd: testHome(), project_root: testHome(), session_id: 'fixture' }
}

test('command input, JSON denial, context, exit feedback, errors and timeout', async () => {
	let script = join(testHome(), 'hook.js')
	writeFileSync(
		script,
		`let s=''; process.stdin.on('data', x=>s+=x); process.stdin.on('end',()=>{let v=JSON.parse(s); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:v.hook_event_name,permissionDecision:'deny',permissionDecisionReason:v.tool_input.command,additionalContext:v.cwd}}))})`,
	)
	let result = await dispatch('claude', [hook(`node '${script}'`)], 'PreToolUse', 'Bash', {
		...context(),
		tool_input: { command: 'blocked' },
	})
	expect(result).toMatchObject({ block: 'blocked', context: [testHome()] })
	expect(await command(hook('printf feedback >&2; exit 2'), context())).toMatchObject({ block: 'feedback' })
	await expect(command(hook('printf detail; printf failure >&2; exit 1'), context())).rejects.toThrow(
		'stdout:\ndetail\nstderr:\nfailure',
	)
	await expect(
		command({ ...hook('sleep 30'), handler: { command: 'sleep 30', timeout: 0.02 } }, context()),
	).rejects.toThrow('timed out')
	await expect(command(hook(`printf '%s' '{"hookSpecificOutput":{"updatedInput":{}}}'`), context())).rejects.toThrow(
		'unsupported output updatedInput',
	)
	let cancel = new AbortController()
	cancel.abort()
	await expect(command(hook('touch never'), context(), cancel.signal)).rejects.toThrow()
	await expect(command(hook('sleep 30'), context(), AbortSignal.timeout(20))).rejects.toThrow('canceled')
	expect((await command(hook('printf out; printf err >&2; exit 2'), context())).block).toBe('err\nout')
	let mixed = await dispatch(
		'claude',
		[hook('printf context', 'SessionStart'), hook('printf failure >&2; exit 1', 'SessionStart')],
		'SessionStart',
		'startup',
		context(),
	)
	expect(mixed.context).toEqual(['context'])
	expect(mixed.block).toContain('failure')
})

test('trust pins prevent execution before review and after configuration changes', async () => {
	let marker = join(testHome(), 'ran')
	let path = config({ PreToolUse: handler(`touch '${marker}'`) })
	expect(() => install({} as any, 'claude', { cwd: testHome(), sources: [{ path, sha256: '' }] })).toThrow('untrusted')
	expect(existsSync(marker)).toBe(false)
	enable(path)
	writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: handler(`touch '${marker}'; echo changed`) } }))
	let result = await tools.run(
		{ type: 'tool_call', id: 'x', name: 'bash', input: { command: `touch '${marker}'` } },
		{ cwd: testHome(), sessionId: 'fixture', signal: new AbortController().signal },
	)
	expect(result.output).toContain('untrusted')
	expect(existsSync(marker)).toBe(false)
})
test('single reads expose file_path and incompatible file-policy schemas fail closed', async () => {
	let path = config({
		PreToolUse: [
			{
				matcher: 'Read|Write',
				hooks: [
					{
						type: 'command',
						command: `node -e 'let s=""; process.stdin.on("data",x=>s+=x); process.stdin.on("end",()=>{console.error(JSON.parse(s).tool_input.file_path); process.exit(2)})'`,
					},
				],
			},
		],
	})
	enable(path)
	let ctx = { cwd: testHome(), sessionId: 'fixture', signal: new AbortController().signal }
	let read = await tools.run({ type: 'tool_call', id: 'x', name: 'read', input: { path: 'file.txt' } }, ctx)
	expect(read.output).toContain(join(testHome(), 'file.txt'))
	let homeRead = await tools.run({ type: 'tool_call', id: 'x', name: 'read', input: { path: '~/file.txt' } }, ctx)
	expect(homeRead.output).toContain(join(paths.userHome(), 'file.txt'))
	for (let [name, input] of [
		['read', { paths: [{ path: 'a' }, { path: 'b' }] }],
		['edit', { text: 'batch' }],
	] as const) {
		let result = await tools.run({ type: 'tool_call', id: 'x', name, input }, ctx)
		expect(result.output).toContain('unsupported input schema')
		expect(result.isError).toBe(true)
	}
})

test('pre-tool denial stops the real tool and post-tool feedback preserves its output', async () => {
	let path = config({
		PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'printf denied >&2; exit 2' }] }],
	})
	enable(path)
	let marker = join(testHome(), 'never')
	let ctx = { cwd: testHome(), sessionId: 'fixture', signal: new AbortController().signal }
	expect(
		(await tools.run({ type: 'tool_call', id: 'x', name: 'bash', input: { command: `touch '${marker}'` } }, ctx))
			.output,
	).toContain('denied')
	expect(existsSync(marker)).toBe(false)
	plugins.deactivate(entries.pop()!)
	path = config({ PostToolUse: handler('printf review >&2; exit 2') })
	enable(path)
	let entry: Loaded = { path: 'base.ts', hash: '', hooks: [], open: true }
	entries.unshift(entry)
	plugins
		.api(entry)
		.around(tools, 'all', () => [
			{ name: 'fixture', description: '', parameters: {}, run: async () => 'original output' },
		])
	let result = await tools.run({ type: 'tool_call', id: 'x', name: 'fixture', input: {} }, ctx)
	expect(result.output).toContain('original output')
	expect(result.output).toContain('review')
})

test('request hooks block before any provider request and deliver startup context', async () => {
	let id = sessions.create({ cwd: testHome(), model: 'openai/gpt-6-astra' }).id
	history.submit(id, 'hello')
	let path = config({
		SessionStart: handler('printf startup-context'),
		UserPromptSubmit: handler('printf rejected >&2; exit 2'),
	})
	enable(path)
	let events = []
	for await (let event of roundStream.stream(id, 'openai/gpt-6-astra', {}, new AbortController().signal))
		events.push(event)
	expect(events).toEqual([{ type: 'error', message: expect.stringContaining('UserPromptSubmit: rejected') }])
	expect(history.readSync(id).some((r) => r.type === 'notice' && r.text.includes('startup-context'))).toBe(true)
})

test('package defaults, inline forms, Codex override, TOML, and symlink containment', () => {
	let root = join(testHome(), 'package')
	mkdirSync(join(root, '.claude-plugin'), { recursive: true })
	mkdirSync(join(root, '.codex-plugin'), { recursive: true })
	mkdirSync(join(root, 'hooks'), { recursive: true })
	writeFileSync(join(root, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: handler('echo default') } }))
	writeFileSync(
		join(root, '.claude-plugin/plugin.json'),
		JSON.stringify({ name: 'fixture', hooks: { PostToolUse: handler('echo extra') } }),
	)
	let source = { path: root, package: true, sha256: '' }
	expect(load('claude', source).hooks.map((h) => h.event)).toEqual(['PreToolUse', 'PostToolUse'])
	writeFileSync(
		join(root, 'plugin.json'),
		JSON.stringify({
			name: 'fixture',
			extensions: { 'com.openai': { hooks: { hooks: { SessionStart: handler('echo inline') } } } },
		}),
	)
	expect(load('codex', source).hooks.map((h) => h.event)).toEqual(['SessionStart'])
	let outside = config({ PreToolUse: handler('echo outside') }, 'outside.json')
	symlinkSync(outside, join(root, 'escape.json'))
	writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ hooks: './escape.json' }))
	expect(() => load('claude', source)).toThrow('escapes package')
	let toml = join(testHome(), 'config.toml')
	writeFileSync(
		toml,
		'[[hooks.PreToolUse]]\nmatcher="Bash"\n[[hooks.PreToolUse.hooks]]\ntype="command"\ncommand="echo ok"\n',
	)
	expect(load('codex', { path: toml, sha256: '' }).hooks).toHaveLength(1)
	expect(matches('claude', 'Bash', 'NotBash')).toBe(false)
	expect(matches('codex', 'Bash', 'NotBash')).toBe(true)
	expect(matches('claude', 'Edit, Write', 'Write')).toBe(true)
})

test('unsupported policies fail visibly instead of becoming inert guards', () => {
	let path = config({ Stop: handler('echo stop') })
	expect(() => load('claude', { path, sha256: '' })).toThrow('unsupported hook event Stop')
	path = config({ PreToolUse: [{ hooks: [{ type: 'command', command: 'echo x', async: true }] }] })
	expect(() => load('codex', { path, sha256: '' })).toThrow('unsupported handler field async')
})
