import { expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { toolDetails } from '../../common/tool-details.ts'
import { transcript } from '../../common/transcript.ts'
import { history } from '../history.ts'
import { calls, client, created, testHome, until, useHost } from '../host-fixture.test.ts'
import { nativeTool } from '../native-tool.ts'
import { tools } from '../tools.ts'
import { saveSecret } from './save_secret.ts'

useHost()

const results = (call: (typeof calls)[number]) =>
	call.input.messages.flatMap((m: any) => m.blocks).filter((b: any) => b.type === 'tool_result')

function git(cwd: string, args: string[]): void {
	let r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

test('SAVE_SECRET prompts securely, writes 0600, warns on replace and never leaks the secret', async () => {
	let work = join(testHome(), 'app')
	mkdirSync(work)
	let envFile = join(work, '.env.prod')
	let c = client()
	let id = created(c, work)

	// First call: missing file -> no replace warning; value written with 0600 and never leaked.
	c.conn.send({ type: 'submit', sessionId: id, text: 'set key' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{
			type: 'tool_call',
			id: 's1',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET /* Add Resend key */ { file: ".env.prod", name: "RESEND_API_KEY" }' },
		},
		{ type: 'done', reason: 'tool_use' },
	)
	await until(() => transcript.question(c.views.get(id)))
	let q1 = transcript.question(c.views.get(id))!
	expect(q1.form.text).toContain('Add Resend key')
	expect(q1.form.text).toContain('.env.prod')
	expect(q1.form.text).not.toContain('This replaces the current value.')
	expect(q1.form.fields).toEqual([{ type: 'secret', name: 'secret', label: 'RESEND_API_KEY' }])
	expect(q1.form.skip).toBe(true)

	let secret1 = 're_live_SUPER_SECRET_111'
	c.conn.send({ type: 'answer', sessionId: id, question: q1.id, answers: { secret: secret1 } })
	await until(() => calls.length === 2)

	expect(readFileSync(envFile, 'utf8')).toBe(`RESEND_API_KEY=${secret1}\n`)
	expect(statSync(envFile).mode & 0o777).toBe(0o600)
	expect(results(calls[1]!)).toEqual([expect.objectContaining({ id: 's1', output: 'saved' })])
	expect(results(calls[1]!)[0].isError).toBeUndefined()

	// Add other lines and loosen permissions, then replace via a second SAVE_SECRET call.
	writeFileSync(envFile, `# comment\nOTHER=1\nRESEND_API_KEY=${secret1}\nRESEND_API_KEY_2=keep\n`)
	chmodSync(envFile, 0o644)
	expect(statSync(envFile).mode & 0o777).toBe(0o644)

	calls[1]!.push(
		{
			type: 'tool_call',
			id: 's2',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env.prod", name: "RESEND_API_KEY" }' },
		},
		{ type: 'done', reason: 'tool_use' },
	)
	await until(() => transcript.question(c.views.get(id))?.id !== q1.id && transcript.question(c.views.get(id)))
	let q2 = transcript.question(c.views.get(id))!
	expect(q2.form.text).toContain('Save RESEND_API_KEY to')
	expect(q2.form.text).toContain('This replaces the current value.')

	let secret2 = 're_live_ROTATED_SECRET_222'
	c.conn.send({ type: 'answer', sessionId: id, question: q2.id, answers: { secret: secret2 } })
	await until(() => calls.length === 3)

	expect(readFileSync(envFile, 'utf8')).toBe(`# comment\nOTHER=1\nRESEND_API_KEY=${secret2}\nRESEND_API_KEY_2=keep\n`)
	expect(statSync(envFile).mode & 0o777).toBe(0o600)
	expect(results(calls[2]!).at(-1)).toMatchObject({ id: 's2', output: 'saved' })

	calls[2]!.push({ type: 'text', text: 'all set' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)

	let historyText = readFileSync(history.file(id), 'utf8')
	let eventsText = JSON.stringify(c.events)
	let providerText = JSON.stringify(calls.map((call) => call.input))
	for (let s of [secret1, secret2]) {
		expect(historyText).not.toContain(s)
		expect(eventsText).not.toContain(s)
		expect(providerText).not.toContain(s)
	}
	expect(c.of('answer')[0]).toMatchObject({ answers: {}, secrets: ['secret'] })
})

test('Escape, empty input and newline values never write and never leak; multi-call rounds save each key', async () => {
	let work = join(testHome(), 'multi')
	mkdirSync(work)
	let envFile = join(work, '.env')
	let c = client()
	let id = created(c, work)

	c.conn.send({ type: 'submit', sessionId: id, text: 'keys' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{
			type: 'tool_call',
			id: 'c1',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_ESC" }' },
		},
		{
			type: 'tool_call',
			id: 'c2',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_EMPTY" }' },
		},
		{
			type: 'tool_call',
			id: 'c3',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_BAD" }' },
		},
		{
			type: 'tool_call',
			id: 'c4',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_ONE" }' },
		},
		{
			type: 'tool_call',
			id: 'c5',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_TWO" }' },
		},
		{ type: 'done', reason: 'tool_use' },
	)

	// c1: Escape -> canceled
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_ESC')
	c.conn.send({ type: 'pause', sessionId: id })

	// c2: empty submit -> canceled
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_EMPTY')
	let q2 = transcript.question(c.views.get(id))!
	c.conn.send({ type: 'answer', sessionId: id, question: q2.id, answers: { secret: '' } })

	// c3: value with newline -> error, nothing written, secret never leaked
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_BAD')
	let q3 = transcript.question(c.views.get(id))!
	let badSecret = 'secret_part_A\nINJECTED=1'
	c.conn.send({ type: 'answer', sessionId: id, question: q3.id, answers: { secret: badSecret } })

	// c4 and c5: two valid secrets in the same round
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_ONE')
	let q4 = transcript.question(c.views.get(id))!
	c.conn.send({ type: 'answer', sessionId: id, question: q4.id, answers: { secret: 'val_one_XYZ' } })

	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_TWO')
	let q5 = transcript.question(c.views.get(id))!
	c.conn.send({ type: 'answer', sessionId: id, question: q5.id, answers: { secret: 'val_two_XYZ' } })

	await until(() => calls.length === 2)
	let out = results(calls[1]!)
	expect(out.map((r: any) => [r.id, r.output, !!r.isError])).toEqual([
		['c1', 'canceled', false],
		['c2', 'canceled', false],
		['c3', expect.stringContaining('line break'), true],
		['c4', 'saved', false],
		['c5', 'saved', false],
	])
	expect(readFileSync(envFile, 'utf8')).toBe('KEY_ONE=val_one_XYZ\nKEY_TWO=val_two_XYZ\n')
	expect(statSync(envFile).mode & 0o777).toBe(0o600)

	calls[1]!.push({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)

	let leaked = [badSecret, 'secret_part_A', 'val_one_XYZ', 'val_two_XYZ']
	let allText = readFileSync(history.file(id), 'utf8') + JSON.stringify(c.events) + JSON.stringify(calls[1]!.input)
	for (let s of leaked) expect(allText).not.toContain(s)
})

test('writeEnv replaces or appends cleanly, keeps other lines, enforces 0600 and rejects newlines', () => {
	let dir = join(testHome(), 'envtest')
	mkdirSync(dir)
	let file = join(dir, '.env')

	// Append to a file without a trailing newline and with loose permissions.
	writeFileSync(file, 'FIRST=1\n# SECOND=commented\nSECOND_EXTRA=keep')
	chmodSync(file, 0o644)
	saveSecret.writeEnv(file, 'SECOND', 'val # with spaces "raw"')
	expect(readFileSync(file, 'utf8')).toBe(
		'FIRST=1\n# SECOND=commented\nSECOND_EXTRA=keep\nSECOND=val # with spaces "raw"\n',
	)
	expect(statSync(file).mode & 0o777).toBe(0o600)

	// Replace existing export line in place, preserving export prefix.
	writeFileSync(file, 'A=1\nexport B=old\nC=3\n')
	saveSecret.writeEnv(file, 'B', 'new_val')
	expect(readFileSync(file, 'utf8')).toBe('A=1\nexport B=new_val\nC=3\n')

	// Reject CR/LF without changing the file.
	expect(() => saveSecret.writeEnv(file, 'B', 'bad\nline')).toThrow(/line break/)
	expect(() => saveSecret.writeEnv(file, 'B', 'bad\rline')).toThrow(/line break/)
	expect(readFileSync(file, 'utf8')).toBe('A=1\nexport B=new_val\nC=3\n')
})

test('git work tree files are refused unless git-ignored and untracked; invalid names fail without prompting', async () => {
	let repo = join(testHome(), 'repo')
	let outside = join(testHome(), 'outside')
	mkdirSync(repo)
	mkdirSync(outside)
	git(repo, ['init', '-q'])
	git(repo, ['config', 'user.email', 'test@example.invalid'])
	git(repo, ['config', 'user.name', 'Test'])
	writeFileSync(join(repo, '.gitignore'), '.env.ignored\n.env.tracked\n')
	writeFileSync(join(repo, '.env.tracked'), 'OLD=1\n')
	git(repo, ['add', '-f', '.gitignore', '.env.tracked'])
	git(repo, ['commit', '-q', '-m', 'init'])
	symlinkSync(join(repo, '.env.unignored'), join(outside, 'link-into-repo'))

	let c = client()
	let id = created(c, repo)
	c.conn.send({ type: 'submit', sessionId: id, text: 'try bad' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{ type: 'tool_call', id: 'g1', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".env.unignored", name: "K" }' } },
		{ type: 'tool_call', id: 'g2', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".env.tracked", name: "K" }' } },
		{ type: 'tool_call', id: 'g3', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".git/env", name: "K" }' } },
		{
			type: 'tool_call',
			id: 'g4',
			name: 'tool',
			input: { cmd: `SAVE_SECRET { file: ${JSON.stringify(join(outside, 'link-into-repo'))}, name: "K" }` },
		},
		{ type: 'tool_call', id: 'n1', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".env.ignored", name: "bad" }' } },
		{ type: 'tool_call', id: 'n2', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".env.ignored", name: "1A" }' } },
		{ type: 'tool_call', id: 'ok', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".env.ignored", name: "OK_1" }' } },
		{ type: 'done', reason: 'tool_use' },
	)

	// Only the git-ignored, valid call opens a question; all invalid ones skip prompting.
	await until(() => transcript.question(c.views.get(id)))
	let q = transcript.question(c.views.get(id))!
	expect(q.form.fields[0]?.label).toBe('OK_1')
	c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { secret: 'ignored_ok_secret' } })
	await until(() => calls.length === 2)

	let out = results(calls[1]!)
	expect(out.slice(0, 6).every((r: any) => r.isError)).toBe(true)
	expect(out[0].output).toContain('not git-ignored')
	expect(out[1].output).toContain('not git-ignored')
	expect(out[2].output).toContain('.git')
	expect(out[3].output).toContain('not git-ignored')
	expect(out[4].output).toContain('[A-Z_][A-Z0-9_]*')
	expect(out[5].output).toContain('[A-Z_][A-Z0-9_]*')
	expect(out[6]).toMatchObject({ id: 'ok', output: 'saved' })
	expect(existsSync(join(repo, '.env.unignored'))).toBe(false)
	expect(readFileSync(join(repo, '.env.ignored'), 'utf8')).toBe('OK_1=ignored_ok_secret\n')
	expect(statSync(join(repo, '.env.ignored')).mode & 0o777).toBe(0o600)
})

test('HELP, Other tools line and card headlines describe SAVE_SECRET clearly', async () => {
	let c = client()
	let id = created(c)
	let helpRes = await tools.run(
		{ type: 'tool_call', id: 'h', name: 'help', input: { name: 'SAVE_SECRET' } },
		{ sessionId: id, cwd: testHome(), signal: new AbortController().signal },
	)
	expect(helpRes.output).toContain('## SAVE_SECRET')
	expect(helpRes.output).toContain('SAVE_SECRET /* <purpose> */ { file, name }')
	expect(helpRes.output).toContain('0600')

	let guides = nativeTool.guides()
	expect(guides).toContain(
		'SAVE_SECRET /* Add or update API_KEY in .env */ { file: ".env", name: "API_KEY" } // prompt user securely for the key; model never sees it',
	)

	expect(
		toolDetails.headline('save_secret', {
			description: 'Add Resend API key to prod env',
			file: '/app/.env.prod',
			name: 'RESEND_API_KEY',
		}),
	).toEqual({ text: 'save_secret Add Resend API key to prod env', key: 'description', mark: 'save_secret' })

	expect(toolDetails.headline('save_secret', { file: '.env.prod', name: 'RESEND_API_KEY' })).toEqual({
		text: 'save_secret Save RESEND_API_KEY to .env.prod',
		keys: ['name', 'file'],
		mark: 'save_secret',
	})
})
